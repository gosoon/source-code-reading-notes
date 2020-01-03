---
title: kubelet statusManager 源码分析
date: 2019-12-25 15:22:30
tags: ["kubelet","statusManager"]
type: "statusManager"

---
* [statusManager 源码分析](#statusmanager-源码分析)
   * [statusManager 的初始化](#statusmanager-的初始化)
   * [syncPod](#syncpod)
      * [needsUpdate](#needsupdate)
         * [PodResourcesAreReclaimed](#podresourcesarereclaimed)
   * [syncBatch](#syncbatch)
      * [needsReconcile](#needsreconcile)
   * [SetPodStatus](#setpodstatus)
      * [updateStatusInternal](#updatestatusinternal)
   * [SetContainerReadiness](#setcontainerreadiness)
   * [SetContainerStartup](#setcontainerstartup)
   * [TerminatePod](#terminatepod)
   * [RemoveOrphanedStatuses](#removeorphanedstatuses)
* [总结](#总结)



本篇文章没有接上篇继续更新 kube-controller-manager，kube-controller-manager 的源码阅读笔记也会继续更新，笔者会同时阅读多个组件的源码，阅读笔记也会按组件进行交叉更新，交叉更新的目的一是为了加深印象避免阅读完后又很快忘记，二是某些代码的功能难以理解，避免死磕，但整体目标是将每个组件的核心代码阅读完。



在前面的文章中已经介绍过 kubelet 的架构以及启动流程，本章会继续介绍 kubelet 中的核心功能，kubelet 中包含数十个 manager 以及对 CNI、CRI、CSI 的调用。每个 manager 的功能各不相同，manager 之间也会有依赖关系，本文会介绍比较简单的 statusManager。



### statusManager 源码分析

> kubernetes 版本：v1.16



statusManager 的主要功能是将 pod 状态信息同步到 apiserver，statusManage 并不会主动监控 pod 的状态，而是提供接口供其他 manager 进行调用。

#### statusManager 的初始化

kubelet 在启动流程时会在 `NewMainKubelet` 方法中初始化其核心组件，包括各种 manager。



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:335`

```
func NewMainKubelet() (*Kubelet, error) {
	......
	// statusManager 的初始化
	klet.statusManager = status.NewManager(klet.kubeClient, klet.podManager, klet)
	......
}
```



`NewManager` 是用来初始化 statusManager 对象的，其中参数的功能如下所示：
- kubeClient：用于和 apiserver 交互；
- podManager：负责内存中 pod 的维护；
- podStatuses：statusManager 的 cache，保存 pod 与状态的对应关系；
- podStatusesChannel：当其他组件调用 statusManager 更新 pod 状态时，会将 pod 的状态信息发送到podStatusesChannel 中；
- apiStatusVersions：维护最新的 pod status 版本号，每更新一次会加1；
- podDeletionSafety：删除 pod 的接口；

  

`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:118`

```
func NewManager(kubeClient clientset.Interface, podManager kubepod.Manager, podDeletionSafety PodDeletionSafetyProvider) Manager {
    return &manager{
        kubeClient:        kubeClient,
        podManager:        podManager,
        podStatuses:       make(map[types.UID]versionedPodStatus),
        podStatusChannel:  make(chan podStatusSyncRequest, 1000), 
        apiStatusVersions: make(map[kubetypes.MirrorPodUID]uint64),
        podDeletionSafety: podDeletionSafety,
    }
}
```



在初始化完成后，kubelet 会在 Run 方法中会以 goroutine 的方式启动 statusManager。

`k8s.io/kubernetes/pkg/kubelet/kubelet.go:1398`

```
func (kl *Kubelet) Run(updates <-chan kubetypes.PodUpdate) {
    ......
    kl.statusManager.Start()
    ......
}
```



statusManager 的代码主要在 `k8s.io/kubernetes/pkg/kubelet/status/` 目录中，其对外暴露的接口有以下几个：

```
type Manager interface {
    // 一个 interface 用来暴露给其他组件获取 pod status 的
    PodStatusProvider

    // 启动 statusManager 的方法
    Start()

    // 设置 pod 的状态并会触发一个状态同步操作
    SetPodStatus(pod *v1.Pod, status v1.PodStatus)

    // 设置 pod .status.containerStatuses 中 container 是否为 ready 状态并触发状态同步操作
    SetContainerReadiness(podUID types.UID, containerID kubecontainer.ContainerID, ready bool)

    // 设置 pod .status.containerStatuses 中 container 是否为 started 状态并触发状态同步操作
    SetContainerStartup(podUID types.UID, containerID kubecontainer.ContainerID, started bool)

    // 将 pod .status.containerStatuses 和 .status.initContainerStatuses 中 container 的 state 置为 Terminated 状态并触发状态同步操作
    TerminatePod(pod *v1.Pod)

    // 从 statusManager 缓存 podStatuses 中删除对应的 pod
    RemoveOrphanedStatuses(podUIDs map[types.UID]bool)
}
```

pod 对应的 status 字段如下所示：

```
status:
  conditions:
  ......
  containerStatuses:
  - containerID: containerd://64e9d88459b38e90c2a4b4d87db5acd180c820c855a55aabe38e4e11b9b83576
    image: docker.io/library/nginx:1.9
    imageID: sha256:f568d3158b1e871b713cb33aca5a9377bc21a1f644addf41368393d28c35e894
    lastState: {}
    name: nginx-pod
    ready: true
    restartCount: 0
    started: true
    state:
      running:
        startedAt: "2019-12-15T16:13:29Z"
  podIP: 10.15.225.15
  ......
```



然后继续看 statusManager 的启动方法 `start`, 其主要逻辑为：

- 1、设置定时器，`syncPeriod` 默认为 10s；
- 2、启动 `wait.Forever` goroutine 同步 pod 的状态，有两种同步方式，第一种是当监听到某个 pod 状态改变时会调用 `m.syncPod` 进行同步，第二种是当触发定时器时调用 `m.syncBatch` 进行批量同步；



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:147`

```
func (m *manager) Start() {
    // 1、检查 kubeClient 是否被初始化
    if m.kubeClient == nil {
        klog.Infof("Kubernetes client is nil, not starting status manager.")
        return
    }
		
    // 2、设置定时器
    syncTicker := time.Tick(syncPeriod)

    go wait.Forever(func() {
        select {
        // 3、监听 m.podStatusChannel channel，当接收到数据时触发同步操作
        case syncRequest := <-m.podStatusChannel:
        		......
            m.syncPod(syncRequest.podUID, syncRequest.status)
        // 4、定时同步
        case <-syncTicker:
            m.syncBatch()
        }
    }, 0)
}
```



#### syncPod

`syncPod` 是用来同步 pod 最新状态至 apiserver 的方法，主要逻辑为：

- 1、调用 `m.needsUpdate` 判断是否需要同步状态，若 `apiStatusVersions` 中的 status 版本号小于当前接收到的 status 版本号或者 `apistatusVersions` 中不存在该 status 版本号则需要同步，若不需要同步则继续检查 pod 是否处于删除状态，若处于删除状态调用 `m.podDeletionSafety.PodResourcesAreReclaimed` 将  pod 完全删除；
- 2、从 apiserver 获取 pod 的 oldStatus；
- 3、检查 pod `oldStatus` 与 `currentStatus` 的 uid 是否相等，若不相等则说明 pod 被重建过；
- 4、调用 `statusutil.PatchPodStatus` 同步 pod 最新的 status 至 apiserver，并将返回的 pod 作为 newPod；
-  5、检查 newPod 是否处于 terminated 状态，若处于 terminated 状态则调用 apiserver 接口进行删除并从 cache 中清除，删除后 pod 会进行重建；



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:514`

```
func (m *manager) syncPod(uid types.UID, status versionedPodStatus) {
    // 1、判断是否需要同步状态
    if !m.needsUpdate(uid, status) {
        klog.V(1).Infof("Status for pod %q is up-to-date; skipping", uid)
        return
    }

    // 2、获取 pod 的 oldStatus
    pod, err := m.kubeClient.CoreV1().Pods(status.podNamespace).Get(status.podName, metav1.GetOptions{})
    if errors.IsNotFound(err) {
        return
    }
    if err != nil {
        return
    }

    translatedUID := m.podManager.TranslatePodUID(pod.UID)
    // 3、检查 pod UID 是否已经改变
    if len(translatedUID) > 0 && translatedUID != kubetypes.ResolvedPodUID(uid) {
        return
    }
    
    // 4、同步 pod 最新的 status 至 apiserver
    oldStatus := pod.Status.DeepCopy()
    newPod, patchBytes, err := statusutil.PatchPodStatus(m.kubeClient, pod.Namespace, pod.Name, *oldStatus, mergePodStatus(*oldStatus, status.status))
    if err != nil {
        return
    }
    pod = newPod

    m.apiStatusVersions[kubetypes.MirrorPodUID(pod.UID)] = status.version

    // 5、若 newPod 处于 terminated 状态则调用 apiserver 删除该 pod，删除后 pod 会重建
    if m.canBeDeleted(pod, status.status) {
        deleteOptions := metav1.NewDeleteOptions(0)
        deleteOptions.Preconditions = metav1.NewUIDPreconditions(string(pod.UID))
        err = m.kubeClient.CoreV1().Pods(pod.Namespace).Delete(pod.Name, deleteOptions)
        if err != nil {
            return
        }
        // 6、从 cache 中清除
        m.deletePodStatus(uid)
    }
}
```



##### needsUpdate

`needsUpdate` 方法主要是检查 pod 的状态是否需要更新，以及检查当 pod 处于 terminated 状态时保证 pod 被完全删除。

`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:570`

```
func (m *manager) needsUpdate(uid types.UID, status versionedPodStatus) bool {
    latest, ok := m.apiStatusVersions[kubetypes.MirrorPodUID(uid)]
    if !ok || latest < status.version {
        return true
    }
    pod, ok := m.podManager.GetPodByUID(uid)
    if !ok {
        return false
    }
    return m.canBeDeleted(pod, status.status)
}

func (m *manager) canBeDeleted(pod *v1.Pod, status v1.PodStatus) bool {
    if pod.DeletionTimestamp == nil || kubepod.IsMirrorPod(pod) {
        return false
    }
    // 此处说明 pod 已经处于删除状态了
    return m.podDeletionSafety.PodResourcesAreReclaimed(pod, status)
}
```



###### PodResourcesAreReclaimed

`PodResourcesAreReclaimed` 检查 pod 在 node 上占用的所有资源是否已经被回收，其主要逻辑为：

- 1、检查 pod 中的所有 container 是否都处于非 running 状态；
- 2、从 podCache 中获取 podStatus，通过 podStatus 检查 pod 中的 container 是否已被完全删除；
- 3、检查 pod 的 volume 是否被清理；
- 4、检查 pod 的 cgroup 是否被清理；
- 5、若以上几个检查项都通过说明在 kubelet 端 pod 已被完全删除；



`k8s.io/kubernetes/pkg/kubelet/kubelet_pods.go:900`

```
func (kl *Kubelet) PodResourcesAreReclaimed(pod *v1.Pod, status v1.PodStatus) bool {
    // 1、检查 pod 中的所有 container 是否都处于非 running 状态
    if !notRunning(status.ContainerStatuses) {
        return false
    }

    // 2、从 podCache 中获取 podStatus，通过 podStatus 检查 pod 中的 container 是否已被完全删除
    runtimeStatus, err := kl.podCache.Get(pod.UID)
    if err != nil {
        return false
    }
    if len(runtimeStatus.ContainerStatuses) > 0 {
        var statusStr string
        for _, status := range runtimeStatus.ContainerStatuses {
            statusStr += fmt.Sprintf("%+v ", *status)
        }
        return false
    }
    
    // 3、检查 pod 的 volume 是否被清理
    if kl.podVolumesExist(pod.UID) && !kl.keepTerminatedPodVolumes {
        return false
    }
    
    // 4、检查 pod 的 cgroup 是否被清理
    if kl.kubeletConfiguration.CgroupsPerQOS {
        pcm := kl.containerManager.NewPodContainerManager()
        if pcm.Exists(pod) {
            return false
        }
    }
    return true
}
```



#### syncBatch

`syncBatch` 是定期将 statusManager 缓存 podStatuses 中的数据同步到 apiserver 的方法，主要逻辑为：

- 1、调用 `m.podManager.GetUIDTranslations` 从 podManager 中获取 mirrorPod uid 与 staticPod uid 的对应关系；
- 2、从  apiStatusVersions 中清理已经不存在的 pod，遍历 apiStatusVersions，检查 podStatuses 以及 mirrorToPod 中是否存在该对应的 pod，若不存在则从 apiStatusVersions 中删除；
- 3、遍历 podStatuses，首先调用 `needsUpdate` 检查 pod 的状态是否与 apiStatusVersions 中的一致，然后调用 `needsReconcile` 检查 pod 的状态是否与 podManager 中的一致，若不一致则将需要同步的 pod 加入到 updatedStatuses 列表中；
- 4、遍历 updatedStatuses 列表，调用 `m.syncPod` 方法同步状态；



syncBatch 主要是将 statusManage cache 中的数据与 apiStatusVersions 和 podManager 中的数据进行对比是否一致，若不一致则以 statusManage cache 中的数据为准同步至 apiserver。



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:469`

```
func (m *manager) syncBatch() {
    var updatedStatuses []podStatusSyncRequest
    // 1、获取 mirrorPod 与 staticPod 的对应关系
    podToMirror, mirrorToPod := m.podManager.GetUIDTranslations()
    func() { 
        m.podStatusesLock.RLock()
        defer m.podStatusesLock.RUnlock()

        // 2、从 apiStatusVersions 中清理已经不存在的 pod
        for uid := range m.apiStatusVersions {
            _, hasPod := m.podStatuses[types.UID(uid)]
            _, hasMirror := mirrorToPod[uid]
            if !hasPod && !hasMirror {
                delete(m.apiStatusVersions, uid)
            }
        }

        // 3、遍历 podStatuses，将需要同步状态的 pod 加入到 updatedStatuses 列表中
        for uid, status := range m.podStatuses {
            syncedUID := kubetypes.MirrorPodUID(uid)
            if mirrorUID, ok := podToMirror[kubetypes.ResolvedPodUID(uid)]; ok {
                if mirrorUID == "" {
                  continue
                }
                syncedUID = mirrorUID
            }
            if m.needsUpdate(types.UID(syncedUID), status) {
                updatedStatuses = append(updatedStatuses, podStatusSyncRequest{uid, status})
            } else if m.needsReconcile(uid, status.status) {
                delete(m.apiStatusVersions, syncedUID)
                updatedStatuses = append(updatedStatuses, podStatusSyncRequest{uid, status})
            }
        }
    }()

    // 4、调用 m.syncPod 同步 pod 状态
    for _, update := range updatedStatuses {
        m.syncPod(update.podUID, update.status)
    }
}
```



`syncBatch` 中主要调用了两个方法 `needsUpdate` 和 `needsReconcile` ，`needsUpdate` 在上文中已经介绍过了，下面介绍 `needsReconcile` 方法的主要逻辑。



##### needsReconcile

`needsReconcile` 对比当前 pod 的状态与 podManager 中的状态是否一致，podManager 中保存了 node 上 pod 的 object，podManager 中的数据与 apiserver 是一致的，`needsReconcile`  主要逻辑为：

- 1、通过 uid 从 podManager 中获取 pod 对象；
- 2、检查 pod 是否为 static pod，若为 static pod 则获取其对应的 mirrorPod；
- 3、格式化 pod status subResource；
- 4、检查 podManager 中的 status 与 statusManager cache 中的 status 是否一致，若不一致则以 statusManager 为准进行同步；



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:598`

```
func (m *manager) needsReconcile(uid types.UID, status v1.PodStatus) bool {
    // 1、从 podManager 中获取 pod 对象
    pod, ok := m.podManager.GetPodByUID(uid)
    if !ok {
        return false
    }

    // 2、检查 pod 是否为 static pod，若为 static pod 则获取其对应的 mirrorPod
    if kubetypes.IsStaticPod(pod) {
        mirrorPod, ok := m.podManager.GetMirrorPodByPod(pod)
        if !ok {
            return false
        }
        pod = mirrorPod
    }

    podStatus := pod.Status.DeepCopy()
    
    // 3、格式化 pod status subResource
    normalizeStatus(pod, podStatus)

    // 4、检查 podManager 中的 status 与 statusManager cache 中的 status 是否一致
    if isPodStatusByKubeletEqual(podStatus, &status) {
        return false
    }

    return true
}
```

以上就是 statusManager 同步 pod status 的主要逻辑，下面再了解一下 statusManager 对其他组件暴露的方法。



#### SetPodStatus

`SetPodStatus` 是为 pod 设置 status subResource 并会触发同步操作，主要逻辑为：

- 1、检查 `pod.Status.Conditions` 中的类型是否为 kubelet 创建的，kubelet 会创建 `ContainersReady`、`Initialized`、`Ready`、`PodScheduled` 和 `Unschedulable` 五种类型的 conditions；
- 2、调用 `m.updateStatusInternal` 触发更新操作；



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:179`

```
func (m *manager) SetPodStatus(pod *v1.Pod, status v1.PodStatus) {
    m.podStatusesLock.Lock()
    defer m.podStatusesLock.Unlock()

    for _, c := range pod.Status.Conditions {
        if !kubetypes.PodConditionByKubelet(c.Type) {
            klog.Errorf("Kubelet is trying to update pod condition %q for pod %q. "+
                "But it is not owned by kubelet.", string(c.Type), format.Pod(pod))
        }
    }

    status = *status.DeepCopy()

    m.updateStatusInternal(pod, status, pod.DeletionTimestamp != nil)
}
```



##### updateStatusInternal

statusManager 对外暴露的方法中触发状态同步的操作都是由 `updateStatusInternal` 完成的，`updateStatusInternal` 会更新 statusManager 的 cache 并会将 newStatus 发送到 `m.podStatusChannel` 中，然后 statusManager 会调用 `syncPod` 方法同步到 apiserver。

- 1、从 cache 中获取 oldStatus；
- 2、检查 `ContainerStatuses` 和 `InitContainerStatuses` 是否合法；
- 3、为 status 设置 `ContainersReady`、`PodReady`、`PodInitialized`、`PodScheduled` conditions；
- 4、设置 status 的 `StartTime`；
- 5、格式化 status；
- 6、将 newStatus 添加到 statusManager 的 cache podStatuses 中；
- 7、将 newStatus 发送到 `m.podStatusChannel` 中；



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:362`

```
func (m *manager) updateStatusInternal(pod *v1.Pod, status v1.PodStatus, forceUpdate bool) bool {
    var oldStatus v1.PodStatus
    // 1、从 cache 中获取 oldStatus
    cachedStatus, isCached := m.podStatuses[pod.UID]
    if isCached {
        oldStatus = cachedStatus.status
    } else if mirrorPod, ok := m.podManager.GetMirrorPodByPod(pod); ok {
        oldStatus = mirrorPod.Status
    } else {
        oldStatus = pod.Status
    }

    // 2、检查 ContainerStatuses 和 InitContainerStatuses 是否合法
    if err := checkContainerStateTransition(oldStatus.ContainerStatuses, status.ContainerStatuses, pod.Spec.RestartPolicy); err != nil {
        return false
    }
    if err := checkContainerStateTransition(oldStatus.InitContainerStatuses, status.InitContainerStatuses, pod.Spec.RestartPolicy); err != nil {
        klog.Errorf("Status update on pod %v/%v aborted: %v", pod.Namespace, pod.Name, err)
        return false
    }

    // 3、为 status 设置 ContainersReady、PodReady、PodInitialized、PodScheduled conditions
    updateLastTransitionTime(&status, &oldStatus, v1.ContainersReady)

    updateLastTransitionTime(&status, &oldStatus, v1.PodReady)

    updateLastTransitionTime(&status, &oldStatus, v1.PodInitialized)
    
    updateLastTransitionTime(&status, &oldStatus, v1.PodScheduled)

    // 4、设置 status 的 StartTime
    if oldStatus.StartTime != nil && !oldStatus.StartTime.IsZero() {
        status.StartTime = oldStatus.StartTime
    } else if status.StartTime.IsZero() {
        now := metav1.Now()
        status.StartTime = &now
    }

    // 5、格式化 status
    normalizeStatus(pod, &status)

    if isCached && isPodStatusByKubeletEqual(&cachedStatus.status, &status) && !forceUpdate {
        return false 
    }

    // 6、将 newStatus 添加到 statusManager 的 cache podStatuses 中
    newStatus := versionedPodStatus{
        status:       status,
        version:      cachedStatus.version + 1,
        podName:      pod.Name,
        podNamespace: pod.Namespace,
    }
    m.podStatuses[pod.UID] = newStatus

    // 7、将 newStatus 发送到 m.podStatusChannel 中
    select {
    case m.podStatusChannel <- podStatusSyncRequest{pod.UID, newStatus}:
        return true
    default:
        return false
    }
}
```

`SetPodStatus` 方法主要会用在 kubelet 的主 syncLoop 中，并在 `syncPod` 方法中创建 pod 时使用。



#### SetContainerReadiness

`SetContainerReadiness` 方法会设置 pod status subResource 中 container 是否为 ready 状态，其主要逻辑为：

- 1、获取 pod 对象；
- 2、从 `m.podStatuses` 获取 oldStatus；
- 3、通过 containerID 从 pod 中获取 containerStatus；
- 4、若 container status 为 Ready 直接返回，此时该 container 状态无须更新；
- 5、添加 PodReadyCondition 和 ContainersReadyCondition；
- 6、调用 `m.updateStatusInternal` 触发同步操作；



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:198`

```
func (m *manager) SetContainerReadiness(podUID types.UID, containerID kubecontainer.ContainerID, ready bool) {
    m.podStatusesLock.Lock()
    defer m.podStatusesLock.Unlock()

    // 1、获取 pod 对象
    pod, ok := m.podManager.GetPodByUID(podUID)
    if !ok {
        return
    }

    // 2、从 m.podStatuses 获取 oldStatus
    oldStatus, found := m.podStatuses[pod.UID]
    if !found {
        return
    }

    // 3、通过 containerID 从 pod 中获取 containerStatus
    containerStatus, _, ok := findContainerStatus(&oldStatus.status, containerID.String())
    if !ok {
        return
    }

    // 4、若 container status 为 Ready 直接返回，此时该 container 状态无须更新
    if containerStatus.Ready == ready {
        return
    }


    status := *oldStatus.status.DeepCopy()
    containerStatus, _, _ = findContainerStatus(&status, containerID.String())
    containerStatus.Ready = ready

    updateConditionFunc := func(conditionType v1.PodConditionType, condition v1.PodCondition) {
        conditionIndex := -1
        for i, condition := range status.Conditions {
            if condition.Type == conditionType {
                conditionIndex = i
                break
            }
        }
        if conditionIndex != -1 {
            status.Conditions[conditionIndex] = condition
        } else {
            status.Conditions = append(status.Conditions, condition)
        }
    }
    // 5、添加 PodReadyCondition 和 ContainersReadyCondition
    updateConditionFunc(v1.PodReady, GeneratePodReadyCondition(&pod.Spec, status.Conditions, status.ContainerStatuses, status.Phase))
    updateConditionFunc(v1.ContainersReady, GenerateContainersReadyCondition(&pod.Spec, status.ContainerStatuses, status.Phase))
    // 6、调用 m.updateStatusInternal 触发同步操作
    m.updateStatusInternal(pod, status, false)
}
```



`SetContainerReadiness` 方法主要被用在 proberManager 中，关于 proberManager 的功能会在后文说明。



#### SetContainerStartup

`SetContainerStartup` 方法会设置 pod status subResource 中 container 是否为 started 状态，主要逻辑为：

- 1、通过 podUID 从 podManager 中获取 pod 对象；
- 2、从 statusManager 中获取 pod 的 oldStatus；
- 3、检查要更新的 container 是否存在；
- 4、检查目标 container 的 started 状态是否已为期望值；
- 5、设置目标 container 的 started 状态；
- 6、调用 `m.updateStatusInternal` 触发同步操作；



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:255`

```
func (m *manager) SetContainerStartup(podUID types.UID, containerID kubecontainer.ContainerID, started bool) {
    m.podStatusesLock.Lock()
    defer m.podStatusesLock.Unlock()

    // 1、通过 podUID 从 podManager 中获取 pod 对象
    pod, ok := m.podManager.GetPodByUID(podUID)
    if !ok {
        return
    }

    // 2、从 statusManager 中获取 pod 的 oldStatus
    oldStatus, found := m.podStatuses[pod.UID]
    if !found {
        return
    }

    // 3、检查要更新的 container 是否存在
    containerStatus, _, ok := findContainerStatus(&oldStatus.status, containerID.String())
    if !ok {
        klog.Warningf("Container startup changed for unknown container: %q - %q",
            format.Pod(pod), containerID.String())
        return
    }
    
    // 4、检查目标 container 的 started 状态是否已为期望值
    if containerStatus.Started != nil && *containerStatus.Started == started {
        return
    }

    // 5、设置目标 container 的 started 状态
    status := *oldStatus.status.DeepCopy()
    containerStatus, _, _ = findContainerStatus(&status, containerID.String())
    containerStatus.Started = &started

    // 6、触发同步操作
    m.updateStatusInternal(pod, status, false)
}
```

`SetContainerStartup` 方法也是主要被用在 proberManager 中。



#### TerminatePod

`TerminatePod` 方法的主要逻辑是把 pod `.status.containerStatuses` 和 `.status.initContainerStatuses` 中 container 的 state 置为 `Terminated` 状态并触发状态同步操作。



`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:312`

```
func (m *manager) TerminatePod(pod *v1.Pod) {
    m.podStatusesLock.Lock()
    defer m.podStatusesLock.Unlock()
    oldStatus := &pod.Status
    if cachedStatus, ok := m.podStatuses[pod.UID]; ok {
        oldStatus = &cachedStatus.status
    }
    status := *oldStatus.DeepCopy()
    for i := range status.ContainerStatuses {
        status.ContainerStatuses[i].State = v1.ContainerState{
            Terminated: &v1.ContainerStateTerminated{},
        }
    }
    for i := range status.InitContainerStatuses {
        status.InitContainerStatuses[i].State = v1.ContainerState{
            Terminated: &v1.ContainerStateTerminated{},
        }
    }
    m.updateStatusInternal(pod, status, true)
}
```

`TerminatePod` 方法主要会用在 kubelet 的主 syncLoop 中。



#### RemoveOrphanedStatuses

`RemoveOrphanedStatuses` 的主要逻辑是从 statusManager 缓存 podStatuses 中删除对应的 pod。

`k8s.io/kubernetes/pkg/kubelet/status/status_manager.go:457`

```
func (m *manager) RemoveOrphanedStatuses(podUIDs map[types.UID]bool) {
    m.podStatusesLock.Lock()
    defer m.podStatusesLock.Unlock()
    for key := range m.podStatuses {
        if _, ok := podUIDs[key]; !ok {
            klog.V(5).Infof("Removing %q from status map.", key)
            delete(m.podStatuses, key)
        }
    }
}
```



### 总结

本文主要介绍了 statusManager 的功能以及使用，其功能其实非常简单，当 pod 状态改变时 statusManager 会将状态同步到 apiserver，statusManager 也提供了多个接口供其他组件调用，当其他组件需要改变 pod 的状态时会将 pod 的 status 信息发送到 statusManager 进行同步。



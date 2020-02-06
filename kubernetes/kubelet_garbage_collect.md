---
title: kubelet 中垃圾回收机制的设计与实现
date: 2020-02-06 16:03:00
tags: ["kubelet","GarbageCollect"]
type: "kubelet"

---


* [kubelet GarbageCollect 源码分析](#kubelet-garbagecollect-源码分析)
   * [k.StartGarbageCollection](#kstartgarbagecollection)
   * [kl.containerGC.GarbageCollect](#klcontainergcgarbagecollect)
      * [cgc.runtime.GarbageCollect](#cgcruntimegarbagecollect)
      * [cgc.evictContainers](#cgcevictcontainers)
      * [cgc.evictSandboxes](#cgcevictsandboxes)
      * [cgc.evictPodLogsDirectories](#cgcevictpodlogsdirectories)
   * [kl.imageManager.GarbageCollect](#klimagemanagergarbagecollect)
      * [im.freeSpace](#imfreespace)
* [总结](#总结)




kubernetes 中的垃圾回收机制主要有两部分组成：

- 一是由 kube-controller-manager 中的 gc controller 自动回收 kubernetes 中被删除的对象以及其依赖的对象；
- 二是在每个节点上需要回收已退出的容器以及当 node 上磁盘资源不足时回收已不再使用的容器镜像；

本文主要分析 kubelet 中的垃圾回收机制，垃圾回收的主要目的是为了节约宿主上的资源，gc controller 的回收机制可以参考以前的文章 [garbage collector controller 源码分析](https://mp.weixin.qq.com/s?__biz=MzAwNzcyMDY5Mg==&mid=2648900249&idx=1&sn=16456e1156b781e57c00fdfae74f2e3f&chksm=836e7902b419f0140d03c37d4e5f9970c8f8bd665437970348fd64d0ff29f64ecc796600da8b&token=674969506&lang=zh_CN#rd)。


kubelet 中与容器垃圾回收有关的主要有以下三个参数:
- `--maximum-dead-containers-per-container`: 表示一个 pod 最多可以保存多少个已经停止的容器，默认为1；（maxPerPodContainerCount）
- `--maximum-dead-containers`：一个 node 上最多可以保留多少个已经停止的容器，默认为 -1，表示没有限制；
- `--minimum-container-ttl-duration`：已经退出的容器可以存活的最小时间，默认为 0s；

与镜像回收有关的主要有以下三个参数：
- `--image-gc-high-threshold`：当 kubelet 磁盘达到多少时，kubelet 开始回收镜像，默认为 85% 开始回收，根目录以及数据盘；
- `--image-gc-low-threshold`：回收镜像时当磁盘使用率减少至多少时停止回收，默认为 80%；
- `--minimum-image-ttl-duration`：未使用的镜像在被回收前的最小存留时间，默认为 2m0s；


**kubelet 中容器回收过程如下:**
pod 中的容器退出时间超过`--minimum-container-ttl-duration`后会被标记为可回收，一个 pod 中最多可以保留`--maximum-dead-containers-per-container`个已经停止的容器，一个 node 上最多可以保留`--maximum-dead-containers`个已停止的容器。在回收容器时，kubelet 会按照容器的退出时间排序，最先回收退出时间最久的容器。需要注意的是，kubelet 在回收时会将 pod 中的 container 与 sandboxes 分别进行回收，且在回收容器后会将其对应的 log dir 也进行回收；


**kubelet 中镜像回收过程如下:**
当容器镜像挂载点文件系统的磁盘使用率大于`--image-gc-high-threshold`时（containerRuntime 为 docker 时，镜像存放目录默认为 `/var/lib/docker`），kubelet 开始删除节点中未使用的容器镜像，直到磁盘使用率降低至`--image-gc-low-threshold` 时停止镜像的垃圾回收。



### kubelet GarbageCollect 源码分析

> kubernetes 版本：v1.16

GarbageCollect 是在 kubelet 对象初始化完成后启动的，在 `createAndInitKubelet` 方法中首先调用 `kubelet.NewMainKubelet` 初始化了 kubelet 对象，随后调用 `k.StartGarbageCollection` 启动了 GarbageCollect。

`k8s.io/kubernetes/cmd/kubelet/app/server.go:1089`

```
func createAndInitKubelet(......) {
    k, err = kubelet.NewMainKubelet(
        ......
    )
    if err != nil {
        return nil, err
    }

    k.BirthCry()

    k.StartGarbageCollection()

    return k, nil
}
```



#### k.StartGarbageCollection

在 kubelet 中镜像的生命周期和容器的生命周期是通过 imageManager 和 containerGC 管理的。在 `StartGarbageCollection` 方法中会启动容器和镜像垃圾回收两个任务，其主要逻辑为：

- 1、启动 containerGC goroutine，ContainerGC 间隔时间默认为 1 分钟；
- 2、检查 `--image-gc-high-threshold` 参数的值，若为 100 则禁用 imageGC；
- 3、启动 imageGC goroutine，imageGC 间隔时间默认为 5 分钟；



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:1270`

```
func (kl *Kubelet) StartGarbageCollection() {
    loggedContainerGCFailure := false
    
    // 1、启动容器垃圾回收服务
    go wait.Until(func() {
        if err := kl.containerGC.GarbageCollect(); err != nil {
            loggedContainerGCFailure = true
        } else {
            var vLevel klog.Level = 4
            if loggedContainerGCFailure {
                vLevel = 1
                loggedContainerGCFailure = false
            }

            klog.V(vLevel).Infof("Container garbage collection succeeded")
        }
    }, ContainerGCPeriod, wait.NeverStop)
    
    // 2、检查 ImageGCHighThresholdPercent 参数的值
    if kl.kubeletConfiguration.ImageGCHighThresholdPercent == 100 {
        return
    }

    // 3、启动镜像垃圾回收服务
    prevImageGCFailed := false
    go wait.Until(func() {
        if err := kl.imageManager.GarbageCollect(); err != nil {
            ......
            prevImageGCFailed = true
        } else {
            var vLevel klog.Level = 4
            if prevImageGCFailed {
                vLevel = 1
                prevImageGCFailed = false
            }
        }
    }, ImageGCPeriod, wait.NeverStop)
}
```



#### kl.containerGC.GarbageCollect

`kl.containerGC.GarbageCollect` 调用的是 ContainerGC manager 中的方法，ContainerGC 是在 `NewMainKubelet` 中初始化的，ContainerGC 在初始化时需要指定一个 runtime，该 runtime 即 ContainerRuntime，在 kubelet 中即 kubeGenericRuntimeManager，也是在 `NewMainKubelet` 中初始化的。

`k8s.io/kubernetes/pkg/kubelet/kubelet.go`

```
func NewMainKubelet(){
    ......
    // MinAge、MaxPerPodContainer、MaxContainers 分别上文章开头提到的与容器垃圾回收有关的
    // 三个参数
    containerGCPolicy := kubecontainer.ContainerGCPolicy{
        MinAge:             minimumGCAge.Duration,
        MaxPerPodContainer: int(maxPerPodContainerCount),
        MaxContainers:      int(maxContainerCount),
    }
    
    // 初始化 containerGC 模块
    containerGC, err := kubecontainer.NewContainerGC(klet.containerRuntime, containerGCPolicy, klet.sourcesReady)
    if err != nil {
        return nil, err
    }
    ......
}
```

以下是 ContainerGC 的初始化以及 GarbageCollect 的启动：

`k8s.io/kubernetes/pkg/kubelet/container/container_gc.go:68`

```
func NewContainerGC(runtime Runtime, policy ContainerGCPolicy, sourcesReadyProvider SourcesReadyProvider) (ContainerGC, error) {
    if policy.MinAge < 0 {
        return nil, fmt.Errorf("invalid minimum garbage collection age: %v", policy.MinAge)
    }

    return &realContainerGC{
        runtime:              runtime,
        policy:               policy,
        sourcesReadyProvider: sourcesReadyProvider,
    }, nil
}

func (cgc *realContainerGC) GarbageCollect() error {
    return cgc.runtime.GarbageCollect(cgc.policy, cgc.sourcesReadyProvider.AllReady(), false)
}
```

可以看到，ContainerGC 中的 GarbageCollect 最终是调用 runtime 中的 GarbageCollect 方法，runtime 即 kubeGenericRuntimeManager。



#####  cgc.runtime.GarbageCollect

cgc.runtime.GarbageCollect 的实现是在 kubeGenericRuntimeManager 中，其主要逻辑为：
- 1、回收 pod 中的 container；
- 2、回收 pod 中的 sandboxes；
- 3、回收 pod 以及 container 的 log dir；



`k8s.io/kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go:378`

```
func (cgc *containerGC) GarbageCollect(gcPolicy kubecontainer.ContainerGCPolicy, allSourcesReady bool, evictTerminatedPods bool) error {
    errors := []error{}
    // 1、回收 pod 中的 container
    if err := cgc.evictContainers(gcPolicy, allSourcesReady, evictTerminatedPods); err != nil {
        errors = append(errors, err)
    }

    // 2、回收 pod 中的 sandboxes
    if err := cgc.evictSandboxes(evictTerminatedPods); err != nil {
        errors = append(errors, err)
    }

    // 3、回收 pod 以及 container 的 log dir
    if err := cgc.evictPodLogsDirectories(allSourcesReady); err != nil {
        errors = append(errors, err)
    }
    return utilerrors.NewAggregate(errors)
}
```



##### cgc.evictContainers

在 `cgc.evictContainers` 方法中会回收所有可被回收的容器，其主要逻辑为：

- 1、首先调用 `cgc.evictableContainers` 获取可被回收的容器作为 evictUnits，可被回收的容器指非 running 状态且创建时间超过 MinAge，evictUnits 数组中包含 pod 与 container 的对应关系；
- 2、回收 deleted 状态以及 terminated 状态的 pod，遍历 evictUnits，若 pod 是否处于 deleted 或者 terminated 状态，则调用 `cgc.removeOldestN` 回收 pod 中的所有容器。deleted 状态指 pod 已经被删除或者其 `status.phase` 为 failed 且其 `status.reason` 为 evicted 或者 pod.deletionTimestamp != nil 且 pod 中所有容器的 status 为 terminated 或者 waiting 状态，terminated 状态指 pod 处于 Failed 或者 succeeded 状态；
- 3、对于非 deleted 或者 terminated 状态的 pod，调用 `cgc.enforceMaxContainersPerEvictUnit` 为其保留 `MaxPerPodContainer` 个已经退出的容器，按照容器退出的时间进行排序优先删除退出时间最久的，`MaxPerPodContainer` 在上文已经提过，表示一个 pod 最多可以保存多少个已经停止的容器，默认为1，可以使用 `--maximum-dead-containers-per-container` 在启动时指定；
- 4、若 kubelet 启动时指定了` --maximum-dead-containers`（默认为 -1 即不限制），即需要为 node 保留退出的容器数，若 node 上保留已经停止的容器数超过 `--maximum-dead-containers`，首先计算需要为每个 pod 保留多少个已退出的容器保证其总数不超过 ` --maximum-dead-containers` 的值，若计算结果小于 1 则取 1，即至少保留一个，然后删除每个 pod 中不需要保留的容器，此时若 node 上保留已经停止的容器数依然超过需要保留的最大值，则将 evictUnits 中的容器按照退出时间进行排序删除退出时间最久的容器，使 node 上保留已经停止的容器数满足 `--maximum-dead-containers` 值；



`k8s.io/kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go:222`

```
func (cgc *containerGC) evictContainers(gcPolicy kubecontainer.ContainerGCPolicy, allSourcesReady bool, evictTerminatedPods bool) error {
    // 1、获取可被回收的容器列表
    evictUnits, err := cgc.evictableContainers(gcPolicy.MinAge)
    if err != nil {
        return err
    }

    // 2、回收 Deleted 状态以及 Terminated 状态的 pod，此处 allSourcesReady 指 kubelet 
    //    支持的三种 podSource 是否都可用
    if allSourcesReady {
        for key, unit := range evictUnits {
            if cgc.podStateProvider.IsPodDeleted(key.uid) || (cgc.podStateProvider.IsPodTerminated(key.uid) && evictTerminatedPods) {
                cgc.removeOldestN(unit, len(unit)) 
                delete(evictUnits, key)
            }
        }
    }
    
    // 3、为非 Deleted 状态以及 Terminated 状态的 pod 保留 MaxPerPodContainer 个已经退出的容器
    if gcPolicy.MaxPerPodContainer >= 0 {
        cgc.enforceMaxContainersPerEvictUnit(evictUnits, gcPolicy.MaxPerPodContainer)
    }

    // 4、若 kubelet 启动时指定了 --maximum-dead-containers（默认为 -1 即不限制）参数，
    //   此时需要为 node 保留退出的容器数不能超过 --maximum-dead-containers 个
    if gcPolicy.MaxContainers >= 0 && evictUnits.NumContainers() > gcPolicy.MaxContainers {
        numContainersPerEvictUnit := gcPolicy.MaxContainers / evictUnits.NumEvictUnits()
        if numContainersPerEvictUnit < 1 {
            numContainersPerEvictUnit = 1
        }
        cgc.enforceMaxContainersPerEvictUnit(evictUnits, numContainersPerEvictUnit)

        numContainers := evictUnits.NumContainers()
        if numContainers > gcPolicy.MaxContainers {
            flattened := make([]containerGCInfo, 0, numContainers)
            for key := range evictUnits {
                flattened = append(flattened, evictUnits[key]...)
            }
            sort.Sort(byCreated(flattened))

            cgc.removeOldestN(flattened, numContainers-gcPolicy.MaxContainers)
        }
    }
    return nil
}
```



##### cgc.evictSandboxes

`cgc.evictSandboxes` 方法会回收所有可回收的 sandboxes，其主要逻辑为：

- 1、首先获取 node 上所有的 containers 和 sandboxes；
- 2、构建 sandboxes 与 pod 的对应关系并将其保存在 sandboxesByPodUID 中；
- 3、对 sandboxesByPodUID 列表按创建时间进行排序；
- 4、若 sandboxes 所在的 pod 处于 deleted 状态，则删除该 pod 中所有的 sandboxes 否则只保留退出时间最短的一个 sandboxes，deleted 状态在上文 `cgc.evictContainers` 方法中已经解释过；



`k8s.io/kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go:274`

```
func (cgc *containerGC) evictSandboxes(evictTerminatedPods bool) error {
    // 1、获取 node 上所有的 container
    containers, err := cgc.manager.getKubeletContainers(true)
    if err != nil {
        return err
    }
    // 2、获取 node 上所有的 sandboxes
    sandboxes, err := cgc.manager.getKubeletSandboxes(true)
    if err != nil {
        return err
    }

    // 3、收集所有 container 的 PodSandboxId 
    sandboxIDs := sets.NewString()
    for _, container := range containers {
        sandboxIDs.Insert(container.PodSandboxId)
    }

    // 4、构建 sandboxes 与 pod 的对应关系并将其保存在 sandboxesByPodUID 中
    sandboxesByPod := make(sandboxesByPodUID)
    for _, sandbox := range sandboxes {
        podUID := types.UID(sandbox.Metadata.Uid)
        sandboxInfo := sandboxGCInfo{
            id:         sandbox.Id,
            createTime: time.Unix(0, sandbox.CreatedAt),
        }
        
        if sandbox.State == runtimeapi.PodSandboxState_SANDBOX_READY {
            sandboxInfo.active = true
        }

        if sandboxIDs.Has(sandbox.Id) {
            sandboxInfo.active = true
        }

        sandboxesByPod[podUID] = append(sandboxesByPod[podUID], sandboxInfo)
    }

    // 5、对 sandboxesByPod 进行排序
    for uid := range sandboxesByPod {
        sort.Sort(sandboxByCreated(sandboxesByPod[uid]))
    }

    // 6、遍历 sandboxesByPod，若 sandboxes 所在的 pod 处于 deleted 状态，
    // 则删除该 pod 中所有的 sandboxes 否则只保留退出时间最短的一个 sandboxes
    for podUID, sandboxes := range sandboxesByPod {
        if cgc.podStateProvider.IsPodDeleted(podUID) || (cgc.podStateProvider.IsPodTerminated(podUID) && evictTerminatedPods) {
            cgc.removeOldestNSandboxes(sandboxes, len(sandboxes))
        } else {
            cgc.removeOldestNSandboxes(sandboxes, len(sandboxes)-1)
        }
    }
    return nil
}
```



##### cgc.evictPodLogsDirectories

`cgc.evictPodLogsDirectories` 方法会回收所有可回收 pod 以及 container 的 log dir，其主要逻辑为：
- 1、首先回收 deleted 状态 pod logs dir，遍历 pod logs dir `/var/log/pods`，`/var/log/pods` 为 pod logs 的默认目录，pod logs dir 的格式为 `/var/log/pods/NAMESPACE_NAME_UID`，解析 pod logs dir 获取 pod uid，判断 pod 是否处于 deleted 状态，若处于 deleted 状态则删除其 logs dir；
- 2、回收 deleted 状态 container logs 链接目录，`/var/log/containers` 为 container log 的默认目录，其会软链接到 pod 的 log dir 下，例如：

  ```
  /var/log/containers/storage-provisioner_kube-system_storage-provisioner-acc8386e409dfb3cc01618cbd14c373d8ac6d7f0aaad9ced018746f31d0081e2.log -> /var/log/pods/kube-system_storage-provisioner_b448e496-eb5d-4d71-b93f-ff7ff77d2348/storage-provisioner/0.log
  ```


`k8s.io/kubernetes/pkg/kubelet/kuberuntime/kuberuntime_gc.go:333`

```
func (cgc *containerGC) evictPodLogsDirectories(allSourcesReady bool) error {
    osInterface := cgc.manager.osInterface
    // 1、回收 deleted 状态 pod logs dir
    if allSourcesReady {
        dirs, err := osInterface.ReadDir(podLogsRootDirectory)
        if err != nil {
            return fmt.Errorf("failed to read podLogsRootDirectory %q: %v", podLogsRootDirectory, err)
        }
        for _, dir := range dirs {
            name := dir.Name()
            podUID := parsePodUIDFromLogsDirectory(name)
            if !cgc.podStateProvider.IsPodDeleted(podUID) {
                continue
            }
            err := osInterface.RemoveAll(filepath.Join(podLogsRootDirectory, name))
            if err != nil {
                klog.Errorf("Failed to remove pod logs directory %q: %v", name, err)
            }
        }
    }
    // 2、回收 deleted 状态 container logs 链接目录
    logSymlinks, _ := osInterface.Glob(filepath.Join(legacyContainerLogsDir, fmt.Sprintf("*.%s", legacyLogSuffix)))
    for _, logSymlink := range logSymlinks {
        if _, err := osInterface.Stat(logSymlink); os.IsNotExist(err) {
            err := osInterface.Remove(logSymlink)
            if err != nil {
                klog.Errorf("Failed to remove container log dead symlink %q: %v", logSymlink, err)
            }
        }
    }
    return nil
}
```



#### kl.imageManager.GarbageCollect

上面已经分析了容器回收的主要流程，下面会继续分析镜像回收的流程，`kl.imageManager.GarbageCollect` 是镜像回收任务启动的方法，镜像回收流程是在 imageManager 中进行的，首先了解下 imageManager 的初始化，imageManager 也是在 `NewMainKubelet` 方法中进行初始化的。

`k8s.io/kubernetes/pkg/kubelet/kubelet.go`

```
func NewMainKubelet(){
    ......    
    // 初始化时需要指定三个参数，三个参数已经在上文中提到过
    imageGCPolicy := images.ImageGCPolicy{
        MinAge:               kubeCfg.ImageMinimumGCAge.Duration,
        HighThresholdPercent: int(kubeCfg.ImageGCHighThresholdPercent),
        LowThresholdPercent:  int(kubeCfg.ImageGCLowThresholdPercent),
    }
    ......
    imageManager, err := images.NewImageGCManager(klet.containerRuntime, klet.StatsProvider, kubeDeps.Recorder, nodeRef, imageGCPolicy, crOptions.PodSandboxImage)
    if err != nil {
        return nil, fmt.Errorf("failed to initialize image manager: %v", err)
    }
    klet.imageManager = imageManager
    ......
}
```



`kl.imageManager.GarbageCollect` 方法的主要逻辑为：
- 1、首先调用 `im.statsProvider.ImageFsStats` 获取容器镜像存储目录挂载点文件系统的磁盘信息；
- 2、获取挂载点的 available 和 capacity 信息并计算其使用率；
- 3、若使用率大于 `HighThresholdPercent`，首先根据 `LowThresholdPercent` 值计算需要释放的磁盘量，然后调用 `im.freeSpace` 释放未使用的 image 直到满足磁盘空闲率；
  

`k8s.io/kubernetes/pkg/kubelet/images/image_gc_manager.go:269`

```
func (im *realImageGCManager) GarbageCollect() error {
    // 1、获取容器镜像存储目录挂载点文件系统的磁盘信息
    fsStats, err := im.statsProvider.ImageFsStats()
    if err != nil {
        return err
    }

    var capacity, available int64
    if fsStats.CapacityBytes != nil {
        capacity = int64(*fsStats.CapacityBytes)
    }
    if fsStats.AvailableBytes != nil {
        available = int64(*fsStats.AvailableBytes)
    }

    if available > capacity {
        available = capacity
    }

    if capacity == 0 {
        err := goerrors.New("invalid capacity 0 on image filesystem")
        im.recorder.Eventf(im.nodeRef, v1.EventTypeWarning, events.InvalidDiskCapacity, err.Error())
        return err
    }
    // 2、若使用率大于 HighThresholdPercent，此时需要回收镜像
    usagePercent := 100 - int(available*100/capacity)
    if usagePercent >= im.policy.HighThresholdPercent {
        // 3、计算需要释放的磁盘量
        amountToFree := capacity*int64(100-im.policy.LowThresholdPercent)/100 - available
        
        // 4、调用 im.freeSpace 回收未使用的镜像信息
        freed, err := im.freeSpace(amountToFree, time.Now())
        if err != nil {
            return err
        }

        if freed < amountToFree {
            err := fmt.Errorf("failed to garbage collect required amount of images. Wanted to free %d bytes, but freed %d bytes", amountToFree, freed)
            im.recorder.Eventf(im.nodeRef, v1.EventTypeWarning, events.FreeDiskSpaceFailed, err.Error())
            return err
        }
    }

    return nil
}
```



##### im.freeSpace

`im.freeSpace` 是回收未使用镜像的方法，其主要逻辑为：
- 1、首先调用 `im.detectImages` 获取已经使用的 images 列表作为 imagesInUse；
- 2、遍历 `im.imageRecords` 根据 imagesInUse 获取所有未使用的 images 信息，`im.imageRecords` 记录 node 上所有 images 的信息；
- 3、根据使用时间对未使用的 images 列表进行排序；
- 4、遍历未使用的 images 列表然后调用 `im.runtime.RemoveImage` 删除镜像，直到回收完所有未使用 images 或者满足空闲率；



`k8s.io/kubernetes/pkg/kubelet/images/image_gc_manager.go:328`

```
func (im *realImageGCManager) freeSpace(bytesToFree int64, freeTime time.Time) (int64, error) {
    // 1、获取已经使用的 images 列表
    imagesInUse, err := im.detectImages(freeTime)
    if err != nil {
        return 0, err
    }

    im.imageRecordsLock.Lock()
    defer im.imageRecordsLock.Unlock()

    // 2、获取所有未使用的 images 信息
    images := make([]evictionInfo, 0, len(im.imageRecords))
    for image, record := range im.imageRecords {
        if isImageUsed(image, imagesInUse) {
            klog.V(5).Infof("Image ID %s is being used", image)
            continue
        }
        images = append(images, evictionInfo{
            id:          image,
            imageRecord: *record,
        })
    }
    // 3、按镜像使用时间进行排序
    sort.Sort(byLastUsedAndDetected(images))
    // 4、回收未使用的镜像
    var deletionErrors []error
    spaceFreed := int64(0)
    for _, image := range images {
        if image.lastUsed.Equal(freeTime) || image.lastUsed.After(freeTime) {
            continue
        }

        if freeTime.Sub(image.firstDetected) < im.policy.MinAge {
            continue
        }

        // 5、调用 im.runtime.RemoveImage 删除镜像
        err := im.runtime.RemoveImage(container.ImageSpec{Image: image.id})
        if err != nil {
            deletionErrors = append(deletionErrors, err)
            continue
        }
        delete(im.imageRecords, image.id)
        spaceFreed += image.size
        if spaceFreed >= bytesToFree {
            break
        }
    }

    if len(deletionErrors) > 0 {
        return spaceFreed, fmt.Errorf("wanted to free %d bytes, but freed %d bytes space with errors in image deletion: %v", bytesToFree, spaceFreed,   errors.NewAggregate(deletionErrors))
    }
    return spaceFreed, nil
}
```



### 总结

本文主要分析了 kubelet 中垃圾回收机制的实现，kubelet 中会定期回收 node 上已经退出的容器已经当 node 磁盘资源不足时回收不再使用的镜像来释放磁盘资源，容器以及镜像回收策略主要是通过 kubelet 中几个参数的阈值进行控制的。



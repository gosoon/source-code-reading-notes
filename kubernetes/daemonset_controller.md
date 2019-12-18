---
title: daemonset controller 源码分析
date: 2019-12-18 10:50:30
tags: ["kube-controller-manager","daemonset controller"]
type: "daemonset controller"

---

![](http://cdn.tianfeiyu.com/daemonset_controlller.png)

在前面的文章中已经分析过 deployment、statefulset 两个重要对象了，本文会继续分析 kubernetes 中另一个重要的对象 daemonset，在 kubernetes 中 daemonset 类似于 linux 上的守护进程会运行在每一个 node 上，在实际场景中，一般会将日志采集或者网络插件采用 daemonset 的方式部署。


### DaemonSet 的基本操作

#### 创建

daemonset 在创建后会在每个 node 上都启动一个 pod。

```
$ kubectl create -f nginx-ds.yaml
```



#### 扩缩容

由于 daemonset 是在每个 node 上启动一个 pod，其不存在扩缩容操作，副本数量跟 node 数量保持一致。



#### 更新

daemonset 有两种更新策略 `OnDelete` 和 `RollingUpdate`，默认为 `RollingUpdate`。滚动更新时，需要指定 `.spec.updateStrategy.rollingUpdate.maxUnavailable`（默认为1）和 `.spec.minReadySeconds`（默认为 0）。

```
// 更新镜像
$ kubectl set image ds/nginx-ds nginx-ds=nginx:1.16

// 查看更新状态
$ kubectl rollout status ds/nginx-ds
```



#### 回滚

在 statefulset 源码分析一节已经提到过 `controllerRevision` 这个对象了，其主要用来保存历史版本信息，在更新以及回滚操作时使用，daemonset controller 也是使用 `controllerrevision` 保存历史版本信息，在回滚时会使用历史 `controllerrevision` 中的信息替换 daemonset 中 `Spec.Template`。

```
// 查看 ds 历史版本信息
$ kubectl get controllerrevision
NAME                  CONTROLLER                REVISION   AGE
nginx-ds-5c4b75bdbb   daemonset.apps/nginx-ds   2          122m
nginx-ds-7cd7798dcd   daemonset.apps/nginx-ds   1          133m

// 回滚到版本 1
$ kubectl rollout undo daemonset nginx-ds --to-revision=1

// 查看回滚状态
$ kubectl rollout status ds/nginx-ds
```

#### 暂停

daemonset 目前不支持暂停操作。

#### 删除

daemonset 也支持两种删除操作。

```
// 非级联删除
$ kubectl delete ds/nginx-ds --cascade=false

// 级联删除
$ kubectl delete ds/nginx-ds
```



### DaemonSetController 源码分析

> kubernetes 版本：v1.16



首先还是看 `startDaemonSetController` 方法，在此方法中会初始化 `DaemonSetsController` 对象并调用 `Run`方法启动 daemonset controller，从该方法中可以看出 daemonset controller 会监听 `daemonsets`、`controllerRevision`、`pod` 和 `node` 四种对象资源的变动。其中 `ConcurrentDaemonSetSyncs `的默认值为 2。

`k8s.io/kubernetes/cmd/kube-controller-manager/app/apps.go:36`

```
func startDaemonSetController(ctx ControllerContext) (http.Handler, bool, error) {
    if !ctx.AvailableResources[schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "daemonsets"}] {
        return nil, false, nil
    }
    dsc, err := daemon.NewDaemonSetsController(
        ctx.InformerFactory.Apps().V1().DaemonSets(),
        ctx.InformerFactory.Apps().V1().ControllerRevisions(),
        ctx.InformerFactory.Core().V1().Pods(),
        ctx.InformerFactory.Core().V1().Nodes(),
        ctx.ClientBuilder.ClientOrDie("daemon-set-controller"),
        flowcontrol.NewBackOff(1*time.Second, 15*time.Minute),
    )
    if err != nil {
        return nil, true, fmt.Errorf("error creating DaemonSets controller: %v", err)
    }
    go dsc.Run(int(ctx.ComponentConfig.DaemonSetController.ConcurrentDaemonSetSyncs), ctx.Stop)
    return nil, true, nil
}
```



在 `Run` 方法中会启动两个操作，一个就是 `dsc.runWorker` 执行的 sync 操作，另一个就是 `dsc.failedPodsBackoff.GC` 执行的 gc 操作，主要逻辑为：

- 1、等待 informer 缓存同步完成；
- 2、启动两个 goroutine 分别执行 `dsc.runWorker`；
- 3、启动一个 goroutine 每分钟执行一次 `dsc.failedPodsBackoff.GC`，从 `startDaemonSetController` 方法中可以看到 `failedPodsBackoff` 的 duration为1s，max duration为15m，`failedPodsBackoff` 的主要作用是当发现 daemon pod 状态为 failed 时，会定时重启该 pod；



`k8s.io/kubernetes/pkg/controller/daemon/daemon_controller.go:263`

```
func (dsc *DaemonSetsController) Run(workers int, stopCh <-chan struct{}) {
    defer utilruntime.HandleCrash()
    defer dsc.queue.ShutDown()

    defer klog.Infof("Shutting down daemon sets controller")

    if !cache.WaitForNamedCacheSync("daemon sets", stopCh, dsc.podStoreSynced, dsc.nodeStoreSynced, dsc.historyStoreSynced, dsc.dsStoreSynced) {
        return
    }

    for i := 0; i < workers; i++ {
        // sync 操作
        go wait.Until(dsc.runWorker, time.Second, stopCh)
    }
		
    // GC 操作
    go wait.Until(dsc.failedPodsBackoff.GC, BackoffGCInterval, stopCh)

    <-stopCh
}
```





#### syncDaemonSet

daemonset 中 pod 的创建与删除是与 node 相关联的，所以每次执行 sync 操作时需要遍历所有的 node 进行判断。`syncDaemonSet` 的主要逻辑为：

- 1、通过 key 获取 ns 和 name；
- 2、从 dsLister 中获取 ds 对象；
- 3、从 nodeLister 获取所有 node；
- 4、获取 dsKey；
- 5、判断 ds 是否处于删除状态；
- 6、调用 `constructHistory` 获取 current 和 old `controllerRevision`；
- 7、调用 `dsc.expectations.SatisfiedExpectations` 判断是否满足 `expectations` 机制，`expectations` 机制的目的就是减少不必要的 sync 操作，关于 `expectations` 机制的详细说明可以参考笔者以前写的 "replicaset controller 源码分析"一文；
- 8、调用 `dsc.manage` 执行实际的 sync 操作；
- 9、判断是否为更新操作，并执行对应的更新操作逻辑；
- 10、调用 `dsc.cleanupHistory` 根据 `spec.revisionHistoryLimit`字段清理过期的 `controllerrevision`；
- 11、调用 `dsc.updateDaemonSetStatus` 更新 ds 状态； 



`k8s.io/kubernetes/pkg/controller/daemon/daemon_controller.go:1212`

```
func (dsc *DaemonSetsController) syncDaemonSet(key string) error {
    ......

    // 1、通过 key 获取 ns 和 name
    namespace, name, err := cache.SplitMetaNamespaceKey(key)
    if err != nil {
        return err
    }
    
    // 2、从 dsLister 中获取 ds 对象
    ds, err := dsc.dsLister.DaemonSets(namespace).Get(name)
    if errors.IsNotFound(err) {
        dsc.expectations.DeleteExpectations(key)
        return nil
    }
    ......

    // 3、从 nodeLister 获取所有 node
    nodeList, err := dsc.nodeLister.List(labels.Everything())
    ......

    everything := metav1.LabelSelector{}
    if reflect.DeepEqual(ds.Spec.Selector, &everything) {
        dsc.eventRecorder.Eventf(ds, v1.EventTypeWarning, SelectingAllReason, "This daemon set is selecting all pods. A non-empty selector is required. ")
        return nil
    }
    
    // 4、获取 dsKey
    dsKey, err := controller.KeyFunc(ds)
    if err != nil {
        return fmt.Errorf("couldn't get key for object %#v: %v", ds, err)
    }

    // 5、判断 ds 是否处于删除状态
    if ds.DeletionTimestamp != nil {
        return nil
    }

    // 6、获取 current 和 old controllerRevision
    cur, old, err := dsc.constructHistory(ds)
    if err != nil {
        return fmt.Errorf("failed to construct revisions of DaemonSet: %v", err)
    }
    hash := cur.Labels[apps.DefaultDaemonSetUniqueLabelKey]
    
    // 7、判断是否满足 expectations 机制
    if !dsc.expectations.SatisfiedExpectations(dsKey) {
        return dsc.updateDaemonSetStatus(ds, nodeList, hash, false)
    }

    // 8、执行实际的 sync 操作
    err = dsc.manage(ds, nodeList, hash)
    if err != nil {
        return err
    }

    // 9、判断是否为更新操作，并执行对应的更新操作
    if dsc.expectations.SatisfiedExpectations(dsKey) {
        switch ds.Spec.UpdateStrategy.Type {
        case apps.OnDeleteDaemonSetStrategyType:
        case apps.RollingUpdateDaemonSetStrategyType:
            err = dsc.rollingUpdate(ds, nodeList, hash)
        }
        if err != nil {
            return err
        }
    }
    // 10、清理过期的 controllerrevision
    err = dsc.cleanupHistory(ds, old)
    if err != nil {
        return fmt.Errorf("failed to clean up revisions of DaemonSet: %v", err)
    }

    // 11、更新 ds 状态
    return dsc.updateDaemonSetStatus(ds, nodeList, hash, true)
}
```

`syncDaemonSet` 中主要有 `manage`、`rollingUpdate`和`updateDaemonSetStatus` 三个方法，分别对应创建、更新与状态同步，下面主要来分析这三个方法。



#### manage

`manage` 主要是用来保证 ds 的 pod 数正常运行在每一个 node 上，其主要逻辑为：

- 1、调用 `dsc.getNodesToDaemonPods` 获取已存在 daemon pod 与 node 的映射关系；
- 2、遍历所有 node，调用 `dsc.podsShouldBeOnNode` 方法来确定在给定的节点上需要创建还是删除 daemon pod；
- 3、判断是否启动了 `ScheduleDaemonSetPods`feature-gates 特性，若启动了则需要删除通过默认调度器已经调度到不存在 node 上的 daemon pod；
- 4、调用 `dsc.syncNodes` 为对应的 node 创建 daemon pod 以及删除多余的 pods；



`k8s.io/kubernetes/pkg/controller/daemon/daemon_controller.go:952`

```
func (dsc *DaemonSetsController) manage(ds *apps.DaemonSet, nodeList []*v1.Node, hash string) error {
    // 1、获取已存在 daemon pod 与 node 的映射关系
    nodeToDaemonPods, err := dsc.getNodesToDaemonPods(ds)
    ......

    // 2、判断每一个 node 是否需要运行 daemon pod
    var nodesNeedingDaemonPods, podsToDelete []string
    for _, node := range nodeList {
        nodesNeedingDaemonPodsOnNode, podsToDeleteOnNode, err := dsc.podsShouldBeOnNode(
            node, nodeToDaemonPods, ds)

        if err != nil {
            continue
        }

        nodesNeedingDaemonPods = append(nodesNeedingDaemonPods, nodesNeedingDaemonPodsOnNode...)
        podsToDelete = append(podsToDelete, podsToDeleteOnNode...)
    }

    // 3、判断是否启动了 ScheduleDaemonSetPods feature-gates 特性，若启用了则对不存在 node 上的 
    // daemon pod 进行删除 
    if utilfeature.DefaultFeatureGate.Enabled(features.ScheduleDaemonSetPods) {
        podsToDelete = append(podsToDelete, getUnscheduledPodsWithoutNode(nodeList, nodeToDaemonPods)...)
    }

    // 4、为对应的 node 创建 daemon pod 以及删除多余的 pods
    if err = dsc.syncNodes(ds, podsToDelete, nodesNeedingDaemonPods, hash); err != nil {
        return err
    }

    return nil
}
```

在 `manage` 方法中又调用了 `getNodesToDaemonPods`、`podsShouldBeOnNode` 和 `syncNodes` 三个方法，继续来看这几种方法的作用。



#####  getNodesToDaemonPods

`getNodesToDaemonPods` 是用来获取已存在 daemon pod 与 node 的映射关系，并且会通过 `adopt/orphan` 方法关联以及释放对应的 pod。

`k8s.io/kubernetes/pkg/controller/daemon/daemon_controller.go:820`

```
func (dsc *DaemonSetsController) getNodesToDaemonPods(ds *apps.DaemonSet) (map[string][]*v1.Pod, error) {
    claimedPods, err := dsc.getDaemonPods(ds)
    if err != nil {
        return nil, err
    }
    nodeToDaemonPods := make(map[string][]*v1.Pod)
    for _, pod := range claimedPods {
        nodeName, err := util.GetTargetNodeName(pod)
        if err != nil {
            klog.Warningf("Failed to get target node name of Pod %v/%v in DaemonSet %v/%v",
                pod.Namespace, pod.Name, ds.Namespace, ds.Name)
            continue
        }

        nodeToDaemonPods[nodeName] = append(nodeToDaemonPods[nodeName], pod)
    }

    return nodeToDaemonPods, nil
}
```



##### podsShouldBeOnNode

`podsShouldBeOnNode` 方法用来确定在给定的节点上需要创建还是删除 daemon pod，主要逻辑为：

- 1、调用 `dsc.nodeShouldRunDaemonPod` 判断该 node 是否需要运行 daemon pod 以及 pod 能不能调度成功，该方法返回三个值 `wantToRun`, `shouldSchedule`, `shouldContinueRunning`；
- 2、通过判断 `wantToRun`, `shouldSchedule`, `shouldContinueRunning` 将需要创建 daemon pod  的 node 列表以及需要删除的 pod 列表获取到， `wantToRun`主要检查的是 selector、taints 等是否匹配，`shouldSchedule` 主要检查 node 上的资源是否充足，`shouldContinueRunning` 默认为 true；



`k8s.io/kubernetes/pkg/controller/daemon/daemon_controller.go:866`

```
func (dsc *DaemonSetsController) podsShouldBeOnNode(...) (nodesNeedingDaemonPods, podsToDelete []string, err error) {
    // 1、判断该 node 是否需要运行 daemon pod 以及能不能调度成功
    wantToRun, shouldSchedule, shouldContinueRunning, err := dsc.nodeShouldRunDaemonPod(node, ds)
    if err != nil {
        return
    }
    // 2、获取该节点上的指定ds的pod列表
    daemonPods, exists := nodeToDaemonPods[node.Name]
    dsKey, err := cache.MetaNamespaceKeyFunc(ds)
    if err != nil {
        utilruntime.HandleError(err)
        return
    }
		
    // 3、从 suspended list 中移除在该节点上 ds 的 pod
    dsc.removeSuspendedDaemonPods(node.Name, dsKey)

    switch {
    // 4、对于需要创建 pod 但是不能调度 pod 的 node，先把 pod 放入到 suspended 队列中
    case wantToRun && !shouldSchedule:
        dsc.addSuspendedDaemonPods(node.Name, dsKey)
    // 5、需要创建 pod 且 pod 未运行，则创建 pod
    case shouldSchedule && !exists:
        nodesNeedingDaemonPods = append(nodesNeedingDaemonPods, node.Name)
    // 6、需要 pod 一直运行
    case shouldContinueRunning:
        var daemonPodsRunning []*v1.Pod
        for _, pod := range daemonPods {
            if pod.DeletionTimestamp != nil {
                continue
            }
            // 7、如果 pod 运行状态为 failed，则删除该 pod
            if pod.Status.Phase == v1.PodFailed {
                backoffKey := failedPodsBackoffKey(ds, node.Name)

                now := dsc.failedPodsBackoff.Clock.Now()
                inBackoff := dsc.failedPodsBackoff.IsInBackOffSinceUpdate(backoffKey, now)
                if inBackoff {
                    delay := dsc.failedPodsBackoff.Get(backoffKey)
                    dsc.enqueueDaemonSetAfter(ds, delay)
                    continue
                }

                dsc.failedPodsBackoff.Next(backoffKey, now)
                podsToDelete = append(podsToDelete, pod.Name)
            } else {
                daemonPodsRunning = append(daemonPodsRunning, pod)
            }
        }
        // 8、如果节点上已经运行 daemon pod 数 > 1，保留运行时间最长的 pod，其余的删除
        if len(daemonPodsRunning) > 1 {
            sort.Sort(podByCreationTimestampAndPhase(daemonPodsRunning))
            for i := 1; i < len(daemonPodsRunning); i++ {
                podsToDelete = append(podsToDelete, daemonPodsRunning[i].Name)
            }
        }
    // 9、如果 pod 不需要继续运行但 pod 已存在则需要删除 pod
    case !shouldContinueRunning && exists:
        for _, pod := range daemonPods {
            if pod.DeletionTimestamp != nil {
                continue
            }
            podsToDelete = append(podsToDelete, pod.Name)
        }
    }

    return nodesNeedingDaemonPods, podsToDelete, nil
}
```



然后继续看 `nodeShouldRunDaemonPod` 方法的主要逻辑：
- 1、调用 `NewPod` 为该 node 构建一个 daemon pod object；
- 2、判断 ds 是否指定了 `.Spec.Template.Spec.NodeName` 字段；
- 3、调用 `dsc.simulate` 执行 `GeneralPredicates` 预选算法检查该 node 是否能够调度成功；
- 4、判断  `GeneralPredicates` 预选算法执行后的  `reasons` 确定 `wantToRun`, `shouldSchedule`, `shouldContinueRunning` 的值；


`k8s.io/kubernetes/pkg/controller/daemon/daemon_controller.go:1337`

```
func (dsc *DaemonSetsController) nodeShouldRunDaemonPod(node *v1.Node, ds *apps.DaemonSet) (wantToRun, shouldSchedule, shouldContinueRunning bool, err   error) {
    // 1、构建 daemon pod object
    newPod := NewPod(ds, node.Name)

    wantToRun, shouldSchedule, shouldContinueRunning = true, true, true
    // 2、判断 ds 是否指定了 node，若指定了且不为当前 node 直接返回 false
    if !(ds.Spec.Template.Spec.NodeName == "" || ds.Spec.Template.Spec.NodeName == node.Name) {
        return false, false, false, nil
    }

    // 3、执行 GeneralPredicates 预选算法
    reasons, nodeInfo, err := dsc.simulate(newPod, node, ds)
    if err != nil {
        ......
    }

    // 4、检查预选算法执行的结果
    var insufficientResourceErr error
    for _, r := range reasons {
        switch reason := r.(type) {
        case *predicates.InsufficientResourceError:
            insufficientResourceErr = reason
        case *predicates.PredicateFailureError:
            var emitEvent bool
            switch reason {
            case
                predicates.ErrNodeSelectorNotMatch,
                predicates.ErrPodNotMatchHostName,
                predicates.ErrNodeLabelPresenceViolated,

                predicates.ErrPodNotFitsHostPorts:
                return false, false, false, nil
            case predicates.ErrTaintsTolerationsNotMatch:
                fitsNoExecute, _, err := predicates.PodToleratesNodeNoExecuteTaints(newPod, nil, nodeInfo)
                if err != nil {
                    return false, false, false, err
                }
                if !fitsNoExecute {
                    return false, false, false, nil
                }
                wantToRun, shouldSchedule = false, false
            case
                predicates.ErrDiskConflict,
                predicates.ErrVolumeZoneConflict,
                predicates.ErrMaxVolumeCountExceeded,
                predicates.ErrNodeUnderMemoryPressure,
                predicates.ErrNodeUnderDiskPressure:
                shouldSchedule = false
                emitEvent = true
            case
                predicates.ErrPodAffinityNotMatch,
                predicates.ErrServiceAffinityViolated:
                
                return false, false, false, fmt.Errorf("unexpected reason: DaemonSet Predicates should not return reason %s", reason.GetReason())
            default:             
                wantToRun, shouldSchedule, shouldContinueRunning = false, false, false
                emitEvent = true
            }
            ......
        }
    }

    if shouldSchedule && insufficientResourceErr != nil {
        dsc.eventRecorder.Eventf(ds, v1.EventTypeWarning, FailedPlacementReason, "failed to place pod on %q: %s", node.ObjectMeta.Name,                  insufficientResourceErr.Error())
        shouldSchedule = false
    }
    return
}
```



##### syncNodes

`syncNodes` 方法主要是为需要 daemon pod 的 node 创建 pod 以及删除多余的 pod，其主要逻辑为：
- 1、将 `createDiff` 和 `deleteDiff` 与 `burstReplicas` 进行比较，`burstReplicas` 默认值为 250 即每个 syncLoop 中创建或者删除的 pod 数最多为 250 个，若超过其值则剩余需要创建或者删除的 pod 在下一个 syncLoop 继续操作；
- 2、将 `createDiff` 和 `deleteDiff` 写入到 `expectations` 中；
- 3、并发创建 pod，创建 pod 有两种方法:（1）创建的 pod 不经过默认调度器，直接指定了 pod 的运行节点(即设定`pod.Spec.NodeName`)；（2）若启用了 `ScheduleDaemonSetPods` feature-gates 特性，则使用默认调度器进行创建 pod，通过 `nodeAffinity`来保证每个节点都运行一个 pod；
- 4、并发删除 `deleteDiff` 中的所有 pod；



`ScheduleDaemonSetPods` 是一个 feature-gates 特性，其出现在 v1.11 中，在 v1.12 中处于 Beta 版本，v1.17 为 GA 版。最初 daemonset controller 只有一种创建 pod 的方法，即直接指定 pod 的 `spec.NodeName` 字段，但是目前这种方式已经暴露了许多问题，在以后的发展中社区还是希望能通过默认调度器进行调度，所以才出现了第二种方式，原因主要有以下五点：

- 1、DaemonSet 无法感知 node 上资源的变化 ([#46935](https://github.com/kubernetes/kubernetes/issues/46935), [#58868](https://github.com/kubernetes/kubernetes/issues/58868))：当 pod 第一次因资源不够无法创建时，若其他 pod 退出后资源足够时 DaemonSet 无法感知到；
- 2、Daemonset 无法支持 Pod Affinity 和 Pod AntiAffinity 的功能([#29276](https://github.com/kubernetes/kubernetes/issues/29276))；
- 3、在某些功能上需要实现和 scheduler 重复的代码逻辑, 例如：critical pods ([#42028](https://github.com/kubernetes/kubernetes/issues/42028)), tolerant/taint；
- 4、当 DaemonSet 的 Pod 创建失败时难以 debug，例如：资源不足时，对于 pending pod 最好能打一个 event 说明；
- 5、多个组件同时调度时难以实现抢占机制：这也是无法通过横向扩展调度器提高调度吞吐量的一个原因； 

更详细的原因可以参考社区的文档：[schedule-DS-pod-by-scheduler.md](https://github.com/kubernetes/community/blob/master/contributors/design-proposals/scheduling/schedule-DS-pod-by-scheduler.md)。



`k8s.io/kubernetes/pkg/controller/daemon/daemon_controller.go:990`

```
func (dsc *DaemonSetsController) syncNodes(ds *apps.DaemonSet, podsToDelete, nodesNeedingDaemonPods []string, hash string) error {
    ......

    // 1、设置 burstReplicas 
    createDiff := len(nodesNeedingDaemonPods)
    deleteDiff := len(podsToDelete)

    if createDiff > dsc.burstReplicas {
        createDiff = dsc.burstReplicas
    }
    if deleteDiff > dsc.burstReplicas {
        deleteDiff = dsc.burstReplicas
    }

    // 2、写入到 expectations 中
    dsc.expectations.SetExpectations(dsKey, createDiff, deleteDiff)

    errCh := make(chan error, createDiff+deleteDiff)
    createWait := sync.WaitGroup{}
    generation, err := util.GetTemplateGeneration(ds)
    if err != nil {
        generation = nil
    }
    template := util.CreatePodTemplate(ds.Spec.Template, generation, hash)

    // 3、并发创建 pod，创建的 pod 数依次为 1, 2, 4, 8, ...
    batchSize := integer.IntMin(createDiff, controller.SlowStartInitialBatchSize)
    for pos := 0; createDiff > pos; batchSize, pos = integer.IntMin(2*batchSize, createDiff-(pos+batchSize)), pos+batchSize {
        errorCount := len(errCh)
        createWait.Add(batchSize)
        for i := pos; i < pos+batchSize; i++ {
            go func(ix int) {
                defer createWait.Done()
                var err error

                podTemplate := template.DeepCopy()
                
                // 4、若启动了 ScheduleDaemonSetPods 功能，则通过 kube-scheduler 创建 pod
                if utilfeature.DefaultFeatureGate.Enabled(features.ScheduleDaemonSetPods) {
                    podTemplate.Spec.Affinity = util.ReplaceDaemonSetPodNodeNameNodeAffinity(
                        podTemplate.Spec.Affinity, nodesNeedingDaemonPods[ix])

                    err = dsc.podControl.CreatePodsWithControllerRef(ds.Namespace, podTemplate,
                        ds, metav1.NewControllerRef(ds, controllerKind))
                } else {
                    // 5、否则直接设置 pod 的 .spec.NodeName 创建 pod
                    err = dsc.podControl.CreatePodsOnNode(nodesNeedingDaemonPods[ix], ds.Namespace, podTemplate,
                        ds, metav1.NewControllerRef(ds, controllerKind))
                }

                // 6、创建 pod 时忽略 timeout err
                if err != nil && errors.IsTimeout(err) {
                    return
                }
                if err != nil {
                    dsc.expectations.CreationObserved(dsKey)
                    errCh <- err
                    utilruntime.HandleError(err)
                }
            }(i)
        }
        createWait.Wait()

        // 7、将创建失败的 pod 数记录到 expectations 中
        skippedPods := createDiff - (batchSize + pos)
        if errorCount < len(errCh) && skippedPods > 0 {
            dsc.expectations.LowerExpectations(dsKey, skippedPods, 0)
            break
        }
    }

    // 8、并发删除 deleteDiff 中的 pod
    deleteWait := sync.WaitGroup{}
    deleteWait.Add(deleteDiff)
    for i := 0; i < deleteDiff; i++ {
        go func(ix int) {
            defer deleteWait.Done()
            if err := dsc.podControl.DeletePod(ds.Namespace, podsToDelete[ix], ds); err != nil {
                dsc.expectations.DeletionObserved(dsKey)
                errCh <- err
                utilruntime.HandleError(err)
            }
        }(i)
    }
    deleteWait.Wait()
    errors := []error{}
    close(errCh)
    for err := range errCh {
        errors = append(errors, err)
    }
    return utilerrors.NewAggregate(errors)
}
```



#### RollingUpdate

daemonset update 的方式有两种 `OnDelete` 和 `RollingUpdate`，当为 `OnDelete` 时需要用户手动删除每一个 pod 后完成更新操作，当为 `RollingUpdate` 时，daemonset controller 会自动控制升级进度。 

当为 `RollingUpdate` 时，主要逻辑为：

- 1、获取 daemonset pod 与 node 的映射关系；
- 2、根据 `controllerrevision` 的 hash 值获取所有未更新的 pods；
- 3、获取 `maxUnavailable`, `numUnavailable` 的 pod 数值，`maxUnavailable` 是从 ds 的 `rollingUpdate` 字段中获取的默认值为 1，`numUnavailable` 的值是通过 daemonset pod 与 node 的映射关系计算每个 node 下是否有 available pod 得到的；
- 4、通过 oldPods 获取 `oldAvailablePods`, `oldUnavailablePods` 的 pod 列表；
- 5、遍历 `oldUnavailablePods` 列表将需要删除的 pod 追加到 `oldPodsToDelete` 数组中。`oldUnavailablePods` 列表中的 pod 分为两种，一种处于更新中，即删除状态，一种处于未更新且异常状态，处于异常状态的都需要被删除；
- 6、遍历 `oldAvailablePods` 列表，此列表中的 pod 都处于正常运行状态，根据 `maxUnavailable` 值确定是否需要删除该 pod 并将需要删除的 pod 追加到 `oldPodsToDelete` 数组中；
- 7、调用 `dsc.syncNodes` 删除 `oldPodsToDelete` 数组中的 pods，`syncNodes` 方法在 `manage` 阶段已经分析过，此处不再详述；



`rollingUpdate`  的结果是找出需要删除的 pods 并进行删除，被删除的 pod 在下一个 syncLoop 中会通过 `manage` 方法使用最新版本的 daemonset template 进行创建，整个滚动更新的过程是通过先删除再创建的方式一步步完成更新的，每次操作都是严格按照 `maxUnavailable` 的值确定需要删除的 pod 数。



`k8s.io/kubernetes/pkg/controller/daemon/update.go:43`

```
func (dsc *DaemonSetsController) rollingUpdate(......) error {
    // 1、获取 daemonset pod 与 node 的映射关系
    nodeToDaemonPods, err := dsc.getNodesToDaemonPods(ds)
    ......

    // 2、获取所有未更新的 pods
    _, oldPods := dsc.getAllDaemonSetPods(ds, nodeToDaemonPods, hash)
    
    // 3、计算 maxUnavailable, numUnavailable 的 pod 数值
    maxUnavailable, numUnavailable, err := dsc.getUnavailableNumbers(ds, nodeList, nodeToDaemonPods)
    if err != nil {
        return fmt.Errorf("couldn't get unavailable numbers: %v", err)
    }
    oldAvailablePods, oldUnavailablePods := util.SplitByAvailablePods(ds.Spec.MinReadySeconds, oldPods)

    // 4、将非 running 状态的 pods 加入到 oldPodsToDelete 中
    var oldPodsToDelete []string
    for _, pod := range oldUnavailablePods {
        if pod.DeletionTimestamp != nil {
            continue
        }
        oldPodsToDelete = append(oldPodsToDelete, pod.Name)
    }
    // 5、根据 maxUnavailable 值确定是否需要删除 pod
    for _, pod := range oldAvailablePods {
        if numUnavailable >= maxUnavailable {
            break
        }
        oldPodsToDelete = append(oldPodsToDelete, pod.Name)
        numUnavailable++
    }
    // 6、调用 syncNodes 方法删除 oldPodsToDelete 数组中的 pods
    return dsc.syncNodes(ds, oldPodsToDelete, []string{}, hash)
}
```

总结一下，`manage` 方法中的主要流程为：

```
            |->  dsc.getNodesToDaemonPods
            |
            |
manage ---- |->  dsc.podsShouldBeOnNode  ---> dsc.nodeShouldRunDaemonPod
            |
            |
            |->  dsc.syncNodes
```



#### updateDaemonSetStatus

`updateDaemonSetStatus` 是 `syncDaemonSet` 中最后执行的方法，主要是用来计算 ds status subresource 中的值并更新其 status。status 如下所示：

```
status:
  currentNumberScheduled: 1  // 已经运行了 DaemonSet Pod的节点数量
  desiredNumberScheduled: 1  // 需要运行该DaemonSet Pod的节点数量
  numberMisscheduled: 0      // 不需要运行 DeamonSet Pod 但是已经运行了的节点数量
  numberReady: 0             // DaemonSet Pod状态为Ready的节点数量
  numberAvailable: 1 		 // DaemonSet Pod状态为Ready且运行时间超过														 										     // Spec.MinReadySeconds 的节点数量
  numberUnavailable: 0			 // desiredNumberScheduled - numberAvailable 的节点数量
  observedGeneration: 3
  updatedNumberScheduled: 1  // 已经完成DaemonSet Pod更新的节点数量
```



`updateDaemonSetStatus` 主要逻辑为：

- 1、调用 `dsc.getNodesToDaemonPods` 获取已存在 daemon pod 与 node 的映射关系；
- 2、遍历所有 node，调用 `dsc.nodeShouldRunDaemonPod` 判断该 node 是否需要运行 daemon pod，然后计算 status 中的部分字段值；
- 3、调用 `storeDaemonSetStatus` 更新 ds status subresource；
- 4、判断 ds 是否需要 resync；



`k8s.io/kubernetes/pkg/controller/daemon/daemon_controller.go:1152`

```
func (dsc *DaemonSetsController) updateDaemonSetStatus(......) error {
    // 1、获取已存在 daemon pod 与 node 的映射关系
    nodeToDaemonPods, err := dsc.getNodesToDaemonPods(ds)
    ......

    var desiredNumberScheduled, currentNumberScheduled, numberMisscheduled, numberReady, updatedNumberScheduled, numberAvailable int
    for _, node := range nodeList {
        // 2、判断该 node 是否需要运行 daemon pod
        wantToRun, _, _, err := dsc.nodeShouldRunDaemonPod(node, ds)
        if err != nil {
            return err
        }

        scheduled := len(nodeToDaemonPods[node.Name]) > 0
        // 3、计算 status 中的字段值
        if wantToRun {
            desiredNumberScheduled++
            if scheduled {
                currentNumberScheduled++
                daemonPods, _ := nodeToDaemonPods[node.Name]
                sort.Sort(podByCreationTimestampAndPhase(daemonPods))
                pod := daemonPods[0]
                if podutil.IsPodReady(pod) {
                    numberReady++
                    if podutil.IsPodAvailable(pod, ds.Spec.MinReadySeconds, metav1.Now()) {
                        numberAvailable++
                    }
                }

                generation, err := util.GetTemplateGeneration(ds)
                if err != nil {
                    generation = nil
                }
                if util.IsPodUpdated(pod, hash, generation) {
                    updatedNumberScheduled++
                }
            }
        } else {
            if scheduled {
                numberMisscheduled++
            }
        }
    }
    numberUnavailable := desiredNumberScheduled - numberAvailable
    // 4、更新 daemonset status subresource
    err = storeDaemonSetStatus(dsc.kubeClient.AppsV1().DaemonSets(ds.Namespace), ds, desiredNumberScheduled, currentNumberScheduled, numberMisscheduled, numberReady, updatedNumberScheduled, numberAvailable, numberUnavailable, updateObservedGen)
    if err != nil {
        return fmt.Errorf("error storing status for daemon set %#v: %v", ds, err)
    }

    // 5、判断 ds 是否需要 resync
    if ds.Spec.MinReadySeconds > 0 && numberReady != numberAvailable {
        dsc.enqueueDaemonSetAfter(ds, time.Duration(ds.Spec.MinReadySeconds)*time.Second)
    }
    return nil
}
```

最后，再总结一下 `syncDaemonSet` 方法的主要流程：

```
                                |-> dsc.getNodesToDaemonPods
                                |
                                |
                  |-> manage -->|-> dsc.podsShouldBeOnNode  ---> dsc.nodeShouldRunDaemonPod
                  |             |
                  |             |
syncDaemonSet --> |             |-> dsc.syncNodes
                  |
                  |-> rollingUpdate
                  |
                  |
                  |-> updateDaemonSetStatus
```



### 总结

在 daemonset controller 中可以看到许多功能都是 deployment 和 statefulset 已有的。在创建 pod 的流程与 replicaset controller 创建 pod 的流程是相似的，都使用了 `expectations` 机制并且限制了在一个 syncLoop 中最多创建或删除的 pod 数。更新方式与 statefulset 一样都有 `OnDelete` 和 `RollingUpdate` 两种， `OnDelete`  方式与 statefulset 相似，都需要手动删除对应的 pod，而  `RollingUpdate`  方式与 statefulset 和 deployment 都有点区别， `RollingUpdate`方式更新时不支持暂停操作并且 pod 是先删除再创建的顺序进行。版本控制方式与 statefulset 的一样都是使用 `controllerRevision`。最后要说的一点是在 v1.12 及以后的版本中，使用 daemonset 创建的 pod 已不再使用直接指定 `.spec.nodeName`的方式绕过调度器进行调度，而是走默认调度器通过 `nodeAffinity` 的方式调度到每一个节点上。 



参考：

https://yq.aliyun.com/articles/702305

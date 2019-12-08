---
title: replicaset controller 源码分析
date: 2019-12-08 17:00:30
tags: ["kube-controller-manager","replicaset controller"]
type: "replicaset controller"

---


在前面的文章中已经介绍了 deployment controller 的设计与实现，deployment 控制的是 replicaset，而 replicaset 控制 pod 的创建与删除，deployment 通过控制 replicaset 实现了滚动更新、回滚等操作。而 replicaset 会直接控制 pod 的创建与删除，本文会继续从源码层面分析 replicaset 的设计与实现。



在分析源码前先考虑一下 replicaset 的使用场景，在平时的操作中其实我们并不会直接操作 replicaset，replicaset 也仅有几个简单的操作，创建、删除、更新等，但其地位是非常重要的，replicaset 的主要功能就是通过 add/del pod 来达到期望的状态。



### ReplicaSetController 源码分析



#### 启动流程

首先来看 replicaSetController 对象初始化以及启动的代码，在 startReplicaSetController 中有两个比较重要的变量：
- BurstReplicas：用来控制在一个 syncLoop 过程中 rs 最多能创建的 pod 数量，设置上限值是为了避免单个 rs 影响整个系统，默认值为 500；
- ConcurrentRSSyncs：指的是需要启动多少个 goroutine 处理 informer 队列中的对象，默认值为 5；



`k8s.io/kubernetes/cmd/kube-controller-manager/app/apps.go:69`
```
func startReplicaSetController(ctx ControllerContext) (http.Handler, bool, error) {
    if !ctx.AvailableResources[schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "replicasets"}] {
        return nil, false, nil
    }
    go replicaset.NewReplicaSetController(
        ctx.InformerFactory.Apps().V1().ReplicaSets(),
        ctx.InformerFactory.Core().V1().Pods(),
        ctx.ClientBuilder.ClientOrDie("replicaset-controller"),
        replicaset.BurstReplicas,
    ).Run(int(ctx.ComponentConfig.ReplicaSetController.ConcurrentRSSyncs), ctx.Stop)
    return nil, true, nil
}
```



下面是 replicaSetController 初始化的具体步骤，可以看到其会监听 pod 以及 rs 两个对象的事件。

`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:109`

```
func NewReplicaSetController(......) *ReplicaSetController {
    ......
    // 1、此处调用 NewBaseController
    return NewBaseController(rsInformer, podInformer, kubeClient, burstReplicas,
        apps.SchemeGroupVersion.WithKind("ReplicaSet"),
        "replicaset_controller",
        "replicaset",
        controller.RealPodControl{
            KubeClient: kubeClient,
            Recorder:   eventBroadcaster.NewRecorder(scheme.Scheme, v1.EventSource{Component: "replicaset-controller"}),
        },
    )
}

func NewBaseController(......) *ReplicaSetController {
    ......
    // 2、ReplicaSetController 初始化
    rsc := &ReplicaSetController{
        GroupVersionKind: gvk,
        kubeClient:       kubeClient,
        podControl:       podControl,
        burstReplicas:    burstReplicas,
        // 3、expectations 的初始化
        expectations:     controller.NewUIDTrackingControllerExpectations(controller.NewControllerExpectations()),
        queue:            workqueue.NewNamedRateLimitingQueue(workqueue.DefaultControllerRateLimiter(), queueName),
    }

    // 4、rsInformer 中注册的 EventHandler
    rsInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc:    rsc.enqueueReplicaSet,
        UpdateFunc: rsc.updateRS,
        DeleteFunc: rsc.enqueueReplicaSet,
    })
    ......

    // 5、podInformer 中注册的 EventHandler
    podInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc: rsc.addPod,
        UpdateFunc: rsc.updatePod,
        DeleteFunc: rsc.deletePod,
    })
    ......

    return rsc
}
```



replicaSetController 初始化完成后会调用 `Run` 方法启动 5 个 goroutine 处理 informer 队列中的事件并进行 sync 操作，kube-controller-manager 中每个 controller 的启动操作都是如下所示流程。

`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:177`

```
func (rsc *ReplicaSetController) Run(workers int, stopCh <-chan struct{}) {
    ......

    // 1、等待 informer 同步缓存
    if !cache.WaitForNamedCacheSync(rsc.Kind, stopCh, rsc.podListerSynced, rsc.rsListerSynced) {
        return
    }

    // 2、启动 5 个 goroutine 执行 worker 方法
    for i := 0; i < workers; i++ {
        go wait.Until(rsc.worker, time.Second, stopCh)
    }

    <-stopCh
}

// 3、worker 方法中调用 rocessNextWorkItem
func (rsc *ReplicaSetController) worker() {
    for rsc.processNextWorkItem() {
    }
}

func (rsc *ReplicaSetController) processNextWorkItem() bool {
    // 4、从队列中取出对象
    key, quit := rsc.queue.Get()
    if quit {
        return false
    }
    defer rsc.queue.Done(key)

    // 5、执行 sync 操作
    err := rsc.syncHandler(key.(string))
    ......

    return true
}
```



#### EventHandler

初始化 replicaSetController 时，其中有一个 `expectations` 字段，这是 rs 中一个比较特殊的机制，为了说清楚 expectations，先来看一下 controller 中所注册的 eventHandler，replicaSetController 会 watch pod 和 replicaSet 两个对象，eventHandler 中注册了对这两种对象的 add、update、delete 三个操作。

##### addPod

- 1、判断 pod 是否处于删除状态；
- 2、获取该 pod 关联的 rs 以及 rsKey，入队 rs 并更新 rsKey 的 expectations；
- 3、若 pod 对象没体现出关联的 rs 则为孤儿 pod，遍历 rsList 查找匹配的 rs，若该 rs.Namespace == pod.Namespace 并且 rs.Spec.Selector 匹配 pod.Labels，则说明该 pod 应该与此 rs 关联，将匹配的 rs 入队；



`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:255`

```
func (rsc *ReplicaSetController) addPod(obj interface{}) {
    pod := obj.(*v1.Pod)

    if pod.DeletionTimestamp != nil {
        rsc.deletePod(pod)
        return
    }

    // 1、获取 pod 所关联的 rs
    if controllerRef := metav1.GetControllerOf(pod); controllerRef != nil {
        rs := rsc.resolveControllerRef(pod.Namespace, controllerRef)
        if rs == nil {
            return
        }
        rsKey, err := controller.KeyFunc(rs)
        if err != nil {
            return
        }
        // 2、更新 expectations，rsKey 的 add - 1
        rsc.expectations.CreationObserved(rsKey)
        rsc.enqueueReplicaSet(rs)
        return
    }


    rss := rsc.getPodReplicaSets(pod)
    if len(rss) == 0 {
        return
    }

    for _, rs := range rss {
        rsc.enqueueReplicaSet(rs)
    }
}
```



##### updatePod

- 1、如果 pod label 改变或者处于删除状态，则直接删除；
- 2、如果 pod 的 OwnerReference 发生改变，此时 oldRS 需要创建 pod，将 oldRS 入队；
- 3、获取 pod 关联的 rs，入队 rs，若 pod 当前处于 ready 并非 available 状态，则会再次将该 rs 加入到延迟队列中，因为 pod 从 ready 到 available 状态需要触发一次 status 的更新；
- 4、否则为孤儿 pod，遍历 rsList 查找匹配的 rs，若找到则将 rs 入队；



`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:298`

```
func (rsc *ReplicaSetController) updatePod(old, cur interface{}) {
    curPod := cur.(*v1.Pod)
    oldPod := old.(*v1.Pod)
    if curPod.ResourceVersion == oldPod.ResourceVersion {
        return
    }

    // 1、如果 pod label 改变或者处于删除状态，则直接删除
    labelChanged := !reflect.DeepEqual(curPod.Labels, oldPod.Labels)
    if curPod.DeletionTimestamp != nil {
        rsc.deletePod(curPod)
        if labelChanged {
            rsc.deletePod(oldPod)
        }
        return
    }

    // 2、如果 pod 的 OwnerReference 发生改变，将 oldRS 入队
    curControllerRef := metav1.GetControllerOf(curPod)
    oldControllerRef := metav1.GetControllerOf(oldPod)
    controllerRefChanged := !reflect.DeepEqual(curControllerRef, oldControllerRef)
    if controllerRefChanged && oldControllerRef != nil {
        if rs := rsc.resolveControllerRef(oldPod.Namespace, oldControllerRef); rs != nil {
            rsc.enqueueReplicaSet(rs)
        }
    }

    // 3、获取 pod 关联的 rs，入队 rs
    if curControllerRef != nil {
        rs := rsc.resolveControllerRef(curPod.Namespace, curControllerRef)
        if rs == nil {
            return
        }

        rsc.enqueueReplicaSet(rs)
        if !podutil.IsPodReady(oldPod) && podutil.IsPodReady(curPod) && rs.Spec.MinReadySeconds > 0 {
            rsc.enqueueReplicaSetAfter(rs, (time.Duration(rs.Spec.MinReadySeconds)*time.Second)+time.Second)
        }
        return
    }


    // 4、查找匹配的 rs
    if labelChanged || controllerRefChanged {
        rss := rsc.getPodReplicaSets(curPod)
        if len(rss) == 0 {
            return
        }
        for _, rs := range rss {
            rsc.enqueueReplicaSet(rs)
        }
    }
}
```



##### deletePod

- 1、确认该对象是否为 pod；
- 2、判断是否为孤儿 pod；
- 3、获取其对应的 rs 以及 rsKey；
- 4、更新 expectations 中 rsKey 的 del 值；
- 5、将 rs 入队；



`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:372`

```
func (rsc *ReplicaSetController) deletePod(obj interface{}) {
    pod, ok := obj.(*v1.Pod)

    if !ok {
        ......
    }

    controllerRef := metav1.GetControllerOf(pod)
    if controllerRef == nil {
        return
    }
    rs := rsc.resolveControllerRef(pod.Namespace, controllerRef)
    if rs == nil {
        return
    }
    rsKey, err := controller.KeyFunc(rs)
    if err != nil {
        return
    }
    // 更新 expectations，该 rsKey 的 del - 1
    rsc.expectations.DeletionObserved(rsKey, controller.PodKey(pod))
    rsc.enqueueReplicaSet(rs)
}
```



##### AddRS 和 DeleteRS

以上两个操作仅仅是将对应的 rs 入队。



#####UpdateRS

其实 updateRS 也仅仅是将对应的 rs 进行入队，不过多了一个打印日志的操作，如下所示：

`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:232`

```
func (rsc *ReplicaSetController) updateRS(old, cur interface{}) {
    oldRS := old.(*apps.ReplicaSet)
    curRS := cur.(*apps.ReplicaSet)

    if *(oldRS.Spec.Replicas) != *(curRS.Spec.Replicas) {
        klog.V(4).Infof("%v %v updated. Desired pod count change: %d->%d", rsc.Kind, curRS.Name, *(oldRS.Spec.Replicas), *(curRS.Spec.Replicas))
    }
    rsc.enqueueReplicaSet(cur)
}
```

至于 expectations 机制会在下文进行分析。



#### syncReplicaSet

syncReplicaSet 是 controller 的核心方法，它会驱动 controller 所控制的对象达到期望状态，主要逻辑如下所示：

- 1、根据 ns/name 获取 rs 对象；
- 2、调用 expectations.SatisfiedExpectations 判断是否需要执行真正的 sync 操作；
- 3、获取所有 pod list；
- 4、根据 pod label 进行过滤获取与该 rs 关联的 pod 列表，对于其中的孤儿 pod 若与该 rs label 匹配则进行关联，若已关联的 pod 与 rs label 不匹配则解除关联关系；
- 5、调用 manageReplicas 进行同步 pod 操作，add/del pod；
- 6、计算 rs 当前的 status 并进行更新；
- 7、若 rs 设置了 MinReadySeconds 字段则将该 rs 加入到延迟队列中；



`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:562`

```
func (rsc *ReplicaSetController) syncReplicaSet(key string) error {
		......

    namespace, name, err := cache.SplitMetaNamespaceKey(key)
    if err != nil {
        return err
    }

    // 1、根据 ns/name 从 informer cache 中获取 rs 对象，
    // 若 rs 已经被删除则直接删除 expectations 中的对象
    rs, err := rsc.rsLister.ReplicaSets(namespace).Get(name)
    if errors.IsNotFound(err) {
        rsc.expectations.DeleteExpectations(key)
        return nil
    }
    ......

    // 2、判断该 rs 是否需要执行 sync 操作
    rsNeedsSync := rsc.expectations.SatisfiedExpectations(key)
    selector, err := metav1.LabelSelectorAsSelector(rs.Spec.Selector)
    if err != nil {
        ......
    }

    // 3、获取所有 pod list
    allPods, err := rsc.podLister.Pods(rs.Namespace).List(labels.Everything())
		......

    // 4、过滤掉异常 pod，处于删除状态或者 failed 状态的 pod 都为非 active 状态
    filteredPods := controller.FilterActivePods(allPods)

    // 5、检查所有 pod，根据 pod 并进行 adopt 与 release 操作，最后获取与该 rs 关联的 pod list
    filteredPods, err = rsc.claimPods(rs, selector, filteredPods)
    ......

    // 6、若需要 sync 则执行 manageReplicas 创建/删除 pod
    var manageReplicasErr error
    if rsNeedsSync && rs.DeletionTimestamp == nil {
        manageReplicasErr = rsc.manageReplicas(filteredPods, rs)
    }
    rs = rs.DeepCopy()
    // 7、计算 rs 当前的 status
    newStatus := calculateStatus(rs, filteredPods, manageReplicasErr)

    // 8、更新 rs status
    updatedRS, err := updateReplicaSetStatus(rsc.kubeClient.AppsV1().ReplicaSets(rs.Namespace), rs, newStatus)


    // 9、判断是否需要将 rs 加入到延迟队列中
    if manageReplicasErr == nil && updatedRS.Spec.MinReadySeconds > 0 &&
        updatedRS.Status.ReadyReplicas == *(updatedRS.Spec.Replicas) &&
        updatedRS.Status.AvailableReplicas != *(updatedRS.Spec.Replicas) {
        rsc.enqueueReplicaSetAfter(updatedRS, time.Duration(updatedRS.Spec.MinReadySeconds)*time.Second)
    }
    return manageReplicasErr
}
```

在 `syncReplicaSet` 方法中有几个重要的操作分别为：`rsc.expectations.SatisfiedExpectations`、`rsc.manageReplicas`、`calculateStatus`，下面一一进行分析。



##### SatisfiedExpectations

该方法主要判断 rs 是否需要执行真正的同步操作，若需要 add/del pod 或者 expectations 已过期则需要进行同步操作。



`k8s.io/kubernetes/pkg/controller/controller_utils.go:181`

```
func (r *ControllerExpectations) SatisfiedExpectations(controllerKey string) bool {
    // 1、若该 key 存在时，判断是否满足条件或者是否超过同步周期
    if exp, exists, err := r.GetExpectations(controllerKey); exists {
        if exp.Fulfilled() {
            return true
        } else if exp.isExpired() {
            return true
        } else {
            return false
        }
    } else if err != nil {
		......
    } else {
        // 2、该 rs 可能为新创建的，需要进行 sync
        ......
    }
    return true
}

// 3、若 add <= 0 且 del <= 0 说明本地观察到的状态已经为期望状态了
func (e *ControlleeExpectations) Fulfilled() bool {
    return atomic.LoadInt64(&e.add) <= 0 && atomic.LoadInt64(&e.del) <= 0
}

// 4、判断 key 是否过期，ExpectationsTimeout 默认值为 5 * time.Minute
func (exp *ControlleeExpectations) isExpired() bool {
    return clock.RealClock{}.Since(exp.timestamp) > ExpectationsTimeout
}
```



##### manageReplicas

manageReplicas 是最核心的方法，它会计算 replicaSet 需要创建或者删除多少个 pod 并调用 apiserver 的接口进行操作，在此阶段仅仅是调用 apiserver 的接口进行创建，并不保证 pod 成功运行，如果在某一轮，未能成功创建的所有 Pod 对象，则不再创建剩余的 pod。一个周期内最多只能创建或删除 500 个 pod，若超过上限值未创建完成的 pod 数会在下一个 syncLoop 继续进行处理。



该方法主要逻辑如下所示：

- 1、计算已存在 pod 数与期望数的差异；
- 2、如果 diff < 0 说明 rs 实际的 pod 数未达到期望值需要继续创建 pod，首先会将需要创建的 pod 数在 expectations 中进行记录，然后调用 slowStartBatch 创建所需要的 pod，slowStartBatch 以指数级增长的方式批量创建 pod，创建 pod 过程中若出现 timeout err 则忽略，若为其他 err 则终止创建操作并更新 expectations；
- 3、如果 diff > 0 说明可能是一次缩容操作需要删除多余的 pod，如果需要删除全部的 pod 则直接进行删除，否则会通过 getPodsToDelete 方法筛选出需要删除的 pod，具体的筛选策略在下文会将到，然后并发删除这些 pod，对于删除失败操作也会记录在 expectations 中；

在 `slowStartBatch` 中会调用 `rsc.podControl.CreatePodsWithControllerRef` 方法创建 pod，若创建 pod 失败会判断是否为创建超时错误，或者可能是超时后失败，但此时认为超时并不影响后续的批量创建动作，大家知道，创建 pod 操作提交到 apiserver 后会经过认证、鉴权、以及动态访问控制三个步骤，此过程有可能会超时，即使真的创建失败了，等到 expectations 过期后在下一个 syncLoop 时会重新创建。



`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:459`

```
func (rsc *ReplicaSetController) manageReplicas(......) error {
    // 1、计算已存在 pod 数与期望数的差异
    diff := len(filteredPods) - int(*(rs.Spec.Replicas))
    rsKey, err := controller.KeyFunc(rs)
    if err != nil {
        ......
    }
    2、如果 <0，则需要创建 pod
    if diff < 0 {
        diff *= -1
        3、判断需要创建的 pod 数是否超过单次 sync 上限值 500
        if diff > rsc.burstReplicas {
            diff = rsc.burstReplicas
        }

        4、在 expectations 中进行记录，若该 key 已经存在会进行覆盖
        rsc.expectations.ExpectCreations(rsKey, diff)

        5、调用 slowStartBatch 创建所需要的 pod
        successfulCreations, err := slowStartBatch(diff, controller.SlowStartInitialBatchSize, func() error {
            err := rsc.podControl.CreatePodsWithControllerRef(rs.Namespace, &rs.Spec.Template, rs, metav1.NewControllerRef(rs, rsc.GroupVersionKind))
            // 6、若为 timeout err 则忽略
            if err != nil && errors.IsTimeout(err) {
                return nil
            }
            return err
        })

        // 7、计算未创建的 pod 数，并记录在 expectations 中
		// 若 pod 创建成功，informer watch 到事件后会在 addPod handler 中更新 expectations
        if skippedPods := diff - successfulCreations; skippedPods > 0 {
            for i := 0; i < skippedPods; i++ {
                rsc.expectations.CreationObserved(rsKey)
            }
        }
        return err
    } else if diff > 0 {
    	// 8、若 diff >0 说明需要删除多创建的 pod
        if diff > rsc.burstReplicas {
            diff = rsc.burstReplicas
        }

		// 9、getPodsToDelete 会按照一定的策略找出需要删除的 pod 列表
        podsToDelete := getPodsToDelete(filteredPods, diff)

		// 10、在 expectations 中进行记录，若该 key 已经存在会进行覆盖
        rsc.expectations.ExpectDeletions(rsKey, getPodKeys(podsToDelete))

        // 11、进行并发删除的操作
        errCh := make(chan error, diff)
        var wg sync.WaitGroup
        wg.Add(diff)
        for _, pod := range podsToDelete {
            go func(targetPod *v1.Pod) {
                defer wg.Done()
                if err := rsc.podControl.DeletePod(rs.Namespace, targetPod.Name, rs); err != nil {
                    podKey := controller.PodKey(targetPod)
					// 12、某次删除操作若失败会记录在 expectations 中
                    rsc.expectations.DeletionObserved(rsKey, podKey)
                    errCh <- err
                }
            }(pod)
        }
        wg.Wait()

		// 13、返回其中一条 err
        select {
        case err := <-errCh:
            if err != nil {
                return err
            }
        default:
        }
    }

    return nil
}
```



`slowStartBatch` 会批量创建出已计算出的 diff pod 数，创建的 pod 数依次为 1、2、4、8......，呈指数级增长，其方法如下所示：

`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:658`

```
func slowStartBatch(count int, initialBatchSize int, fn func() error) (int, error) {
    remaining := count
    successes := 0
    for batchSize := integer.IntMin(remaining, initialBatchSize); batchSize > 0; batchSize = integer.IntMin(2*batchSize, remaining) {
        errCh := make(chan error, batchSize)
        var wg sync.WaitGroup
        wg.Add(batchSize)
        for i := 0; i < batchSize; i++ {
            go func() {
                defer wg.Done()
                if err := fn(); err != nil {
                    errCh <- err
                }
            }()
        }
        wg.Wait()
        curSuccesses := batchSize - len(errCh)
        successes += curSuccesses
        if len(errCh) > 0 {
            return successes, <-errCh
        }
        remaining -= batchSize
    }
    return successes, nil
}
```



若 diff > 0 时再删除 pod 阶段会调用`getPodsToDelete` 对 pod 进行筛选操作，此阶段会选出最劣质的 pod，下面是用到的 6 种筛选方法：
- 1、判断是够绑定了 node：Unassigned < assigned；
- 2、判断 pod phase：PodPending < PodUnknown < PodRunning；
- 3、判断 pod 状态：Not ready < ready；
- 4、若 pod 都为 ready，则按运行时间排序，运行时间最短会被删除：empty time < less time < more time；
- 5、根据 pod 重启次数排序：higher restart counts < lower restart counts；
- 6、按 pod 创建时间进行排序：Empty creation time pods < newer pods < older pods；



上面的几个排序规则遵循互斥原则，从上到下进行匹配，符合条件则排序完成，代码如下所示：

`k8s.io/kubernetes/pkg/controller/replicaset/replica_set.go:684`

```
func getPodsToDelete(filteredPods []*v1.Pod, diff int) []*v1.Pod {
    if diff < len(filteredPods) {
        sort.Sort(controller.ActivePods(filteredPods))
    }
    return filteredPods[:diff]
}
```

`k8s.io/kubernetes/pkg/controller/controller_utils.go:735`

```
type ActivePods []*v1.Pod

func (s ActivePods) Len() int      { return len(s) }
func (s ActivePods) Swap(i, j int) { s[i], s[j] = s[j], s[i] }

func (s ActivePods) Less(i, j int) bool {
    // 1. Unassigned < assigned
    if s[i].Spec.NodeName != s[j].Spec.NodeName && (len(s[i].Spec.NodeName) == 0 || len(s[j].Spec.NodeName) == 0) {
        return len(s[i].Spec.NodeName) == 0
    }

    // 2. PodPending < PodUnknown < PodRunning
    m := map[v1.PodPhase]int{v1.PodPending: 0, v1.PodUnknown: 1, v1.PodRunning: 2}
    if m[s[i].Status.Phase] != m[s[j].Status.Phase] {
        return m[s[i].Status.Phase] < m[s[j].Status.Phase]
    }

    // 3. Not ready < ready
    if podutil.IsPodReady(s[i]) != podutil.IsPodReady(s[j]) {
        return !podutil.IsPodReady(s[i])
    }

    // 4. Been ready for empty time < less time < more time
    if podutil.IsPodReady(s[i]) && podutil.IsPodReady(s[j]) && !podReadyTime(s[i]).Equal(podReadyTime(s[j])) {
        return afterOrZero(podReadyTime(s[i]), podReadyTime(s[j]))
    }

    // 5. Pods with containers with higher restart counts < lower restart counts
    if maxContainerRestarts(s[i]) != maxContainerRestarts(s[j]) {
        return maxContainerRestarts(s[i]) > maxContainerRestarts(s[j])
    }

    // 6. Empty creation time pods < newer pods < older pods
    if !s[i].CreationTimestamp.Equal(&s[j].CreationTimestamp) {
        return afterOrZero(&s[i].CreationTimestamp, &s[j].CreationTimestamp)
    }
    return false
}
```



##### calculateStatus

calculateStatus 会通过当前 pod 的状态计算出 rs 中 status 字段值，status 字段如下所示：

```
status:
  availableReplicas: 10
  fullyLabeledReplicas: 10
  observedGeneration: 1
  readyReplicas: 10
  replicas: 10
```



`k8s.io/kubernetes/pkg/controller/replicaset/replica_set_utils.go:85`

```
func calculateStatus(......) apps.ReplicaSetStatus {
    newStatus := rs.Status
    fullyLabeledReplicasCount := 0
    readyReplicasCount := 0
    availableReplicasCount := 0
    templateLabel := labels.Set(rs.Spec.Template.Labels).AsSelectorPreValidated()
    for _, pod := range filteredPods {
        if templateLabel.Matches(labels.Set(pod.Labels)) {
            fullyLabeledReplicasCount++
        }
        if podutil.IsPodReady(pod) {
            readyReplicasCount++
            if podutil.IsPodAvailable(pod, rs.Spec.MinReadySeconds, metav1.Now()) {
                availableReplicasCount++
            }
        }
    }

    failureCond := GetCondition(rs.Status, apps.ReplicaSetReplicaFailure)
    if manageReplicasErr != nil && failureCond == nil {
        var reason string
        if diff := len(filteredPods) - int(*(rs.Spec.Replicas)); diff < 0 {
            reason = "FailedCreate"
        } else if diff > 0 {
            reason = "FailedDelete"
        }
        cond := NewReplicaSetCondition(apps.ReplicaSetReplicaFailure, v1.ConditionTrue, reason, manageReplicasErr.Error())
        SetCondition(&newStatus, cond)
    } else if manageReplicasErr == nil && failureCond != nil {
        RemoveCondition(&newStatus, apps.ReplicaSetReplicaFailure)
    }

    newStatus.Replicas = int32(len(filteredPods))
    newStatus.FullyLabeledReplicas = int32(fullyLabeledReplicasCount)
    newStatus.ReadyReplicas = int32(readyReplicasCount)
    newStatus.AvailableReplicas = int32(availableReplicasCount)
    return newStatus
}
```



#### expectations 机制

通过上面的分析可知，在 rs 每次入队后进行 sync 操作时，首先需要判断该 rs 是否满足 expectations 机制，那么这个 expectations 的目的是什么？其实，rs 除了有 informer 的缓存外，还有一个本地缓存就是 expectations，expectations 会记录 rs 所有对象需要 add/del 的 pod 数量，若两者都为 0 则说明该 rs 所期望创建的 pod 或者删除的 pod 数已经被满足，若不满足则说明某次在 syncLoop 中创建或者删除 pod 时有失败的操作，则需要等待 expectations 过期后再次同步该 rs。



通过上面对 eventHandler 的分析，再来总结一下触发 replicaSet 对象发生同步事件的条件：
- 1、与 rs 相关的：AddRS、UpdateRS、DeleteRS；
- 2、与 pod 相关的：AddPod、UpdatePod、DeletePod；
- 3、informer 二级缓存的同步；



但是所有的更新事件是否都需要执行 sync 操作？对于除 rs.Spec.Replicas 之外的更新操作其实都没必要执行 sync 操作，因为 spec 其他字段和 status 的更新都不需要创建或者删除 pod。

在 sync 操作真正开始之前，依据 expectations 机制进行判断，确定是否要真正地启动一次 sync，因为在 eventHandler 阶段也会更新 expectations 值，从上面的 eventHandler 中可以看到在 addPod 中会调用 rsc.expectations.CreationObserved 更新 rsKey 的  expectations，将其 add 值 -1，在 deletePod 中调用 rsc.expectations.DeletionObserved 将其 del 值 -1。所以等到 sync 时，若 controllerKey(name 或者 ns/name)满足 expectations 机制则进行 sync 操作，而 updatePod 并不会修改 expectations，所以，expectations 的设计就是当需要创建或删除 pod 才会触发对应的 sync 操作，expectations 机制的目的就是减少不必要的 sync 操作。



什么条件下 expectations 机制会满足？

- 1、当 expectations 中不存在 rsKey 时，也就说首次创建 rs 时；
- 2、当 expectations 中 del 以及 add 值都为 0 时，即 rs 所需要创建或者删除的 pod 数都已满足；
- 3、当 expectations 过期时，即超过 5 分钟未进行 sync 操作；



最后再看一下 expectations 中用到的几个方法：

```
 // 创建了一个 pod 说明 expectations 中对应的 key add 期望值需要减少一个 pod， add -1
 CreationObserved(controllerKey string)

 // 删除了一个 pod 说明 expectations 中对应的 key del 期望值需要减少一个 pod， del - 1
 DeletionObserved(controllerKey string)

 // 写入 key 需要 add 的 pod 数量
 ExpectCreations(controllerKey string, adds int) error

 // 写入 key 需要 del 的 pod 数量
 ExpectDeletions(controllerKey string, dels int) error

 // 删除该 key
 DeleteExpectations(controllerKey string)
```



当在 syncLoop 中发现满足条件时，会执行 manageReplicas 方法，在 manageReplicas 中无论是为 rs 创建还是删除 pod 都会调用 ExpectCreations 和 ExpectDeletions 为 rsKey 创建 expectations 对象。



### 总结

本文主要从源码层面分析了 replicaSetController 的设计与实现，但是不得不说其在设计方面考虑了很多因素，文中只提到了笔者理解了或者思考后稍有了解的一些机制，至于其他设计思想还得自行阅读代码体会。

下面以一个流程图总结下创建 rs 的主要流程。

```
                                    SatisfiedExpectations
                                    (expectations 中不存在
                                     rsKey，rsNeedsSync
                                     为 true)
                                              |              判断 add/del pod
                                              |                     |
                                              |                     ∨
                                              |             创建 expectations 对象,
                                              |             并设置 add/del 值
                                              ∨                     |
create rs --> syncReplicaSet -->       manageReplicas  -->          ∨
                                       (为 rs 创建 pod)       调用 slowStartBatch 批量创建 pod/
                                              |               删除筛选出的多余 pod
                                              |                     |
                                              |                     ∨
                                              |               更新 expectations 对象
                                              ∨
                                    updateReplicaSetStatus
                                    (更新 rs 的 status
                                    subResource)
```







参考：

https://keyla.vip/k8s/3-master/controller/replica-set/




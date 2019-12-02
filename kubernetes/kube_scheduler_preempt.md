---
title: kube-scheduler 优先级与抢占机制源码分析
date: 2019-10-24 14:35:30
tags: ["kube-scheduler","preempt"]
type: "kube-scheduler"

---

前面已经分析了 kube-scheduler 的代码逻辑以及 predicates 与 priorities 算法，本节会继续讲 scheduler 中的一个重要机制，pod 优先级与抢占机制(Pod Priority and Preemption)，该功能是在 v1.8 中引入的，v1.11 中该功能为 beta 版本且默认启用了，v1.14 为 stable 版本。

- [kube-scheduler 源码分析](http://blog.tianfeiyu.com/2019/10/21/kube_scheduler_process/)
- [kube-scheduler predicates 与 priorities 调度算法源码分析](http://blog.tianfeiyu.com/2019/10/22/kube_scheduler_algorithm/)

### 为什么要有优先级与抢占机制

正常情况下，当一个 pod 调度失败后，就会被暂时 “搁置” 处于 `pending` 状态，直到 pod 被更新或者集群状态发生变化，调度器才会对这个 pod 进行重新调度。但在实际的业务场景中会存在在线与离线业务之分，若在线业务的 pod 因资源不足而调度失败时，此时就需要离线业务下掉一部分为在线业务提供资源，即在线业务要抢占离线业务的资源，此时就需要 scheduler 的优先级和抢占机制了，该机制解决的是 pod 调度失败时该怎么办的问题，若该 pod 的优先级比较高此时并不会被”搁置”，而是会”挤走”某个 node 上的一些低优先级的 pod，这样就可以保证高优先级的 pod 调度成功。


### 优先级与抢占机制源码分析

> kubernetes 版本: v1.16

抢占发生的原因，一定是一个高优先级的 pod 调度失败，我们称这个 pod 为“抢占者”，称被抢占的 pod 为“牺牲者”(victims)。而 kubernetes 调度器实现抢占算法的一个最重要的设计，就是在调度队列的实现里，使用了两个不同的队列。

第一个队列叫作 activeQ，凡是在 activeQ 里的 pod，都是下一个调度周期需要调度的对象。所以，当你在 kubernetes 集群里新创建一个 pod 的时候，调度器会将这个 pod 入队到 activeQ 里面，调度器不断从队列里出队(pop)一个 pod 进行调度，实际上都是从 activeQ 里出队的。

第二个队列叫作 unschedulableQ，专门用来存放调度失败的 pod，当一个 unschedulableQ 里的 pod 被更新之后，调度器会自动把这个 pod 移动到 activeQ 里，从而给这些调度失败的 pod “重新做人”的机会。

当 pod 拥有了优先级之后，高优先级的 pod 就可能会比低优先级的 pod 提前出队，从而尽早完成调度过程。

`k8s.io/kubernetes/pkg/scheduler/internal/queue/scheduling_queue.go`
```
// NewSchedulingQueue initializes a priority queue as a new scheduling queue.
func NewSchedulingQueue(stop <-chan struct{}, fwk framework.Framework) SchedulingQueue {
    return NewPriorityQueue(stop, fwk)
}
// NewPriorityQueue creates a PriorityQueue object.
func NewPriorityQueue(stop <-chan struct{}, fwk framework.Framework) *PriorityQueue {
    return NewPriorityQueueWithClock(stop, util.RealClock{}, fwk)
}

// NewPriorityQueueWithClock creates a PriorityQueue which uses the passed clock for time.
func NewPriorityQueueWithClock(stop <-chan struct{}, clock util.Clock, fwk framework.Framework) *PriorityQueue {
    comp := activeQComp
    if fwk != nil {
        if queueSortFunc := fwk.QueueSortFunc(); queueSortFunc != nil {
            comp = func(podInfo1, podInfo2 interface{}) bool {
                pInfo1 := podInfo1.(*framework.PodInfo)
                pInfo2 := podInfo2.(*framework.PodInfo)

                return queueSortFunc(pInfo1, pInfo2)
            }
        }
    }

    pq := &PriorityQueue{
        clock:            clock,
        stop:             stop,
        podBackoff:       NewPodBackoffMap(1*time.Second, 10*time.Second),
        activeQ:          util.NewHeapWithRecorder(podInfoKeyFunc, comp, metrics.NewActivePodsRecorder()),
        unschedulableQ:   newUnschedulablePodsMap(metrics.NewUnschedulablePodsRecorder()),
        nominatedPods:    newNominatedPodMap(),
        moveRequestCycle: -1,
    }
    pq.cond.L = &pq.lock
    pq.podBackoffQ = util.NewHeapWithRecorder(podInfoKeyFunc, pq.podsCompareBackoffCompleted, metrics.NewBackoffPodsRecorder())

    pq.run()

    return pq
}
```



前面的文章已经说了 `scheduleOne()` 是执行调度算法的主逻辑，其主要功能有：
- 调用 `sched.schedule()`，即执行 predicates 算法和 priorities 算法
- 若执行失败，会返回 `core.FitError`
- 若开启了抢占机制，则执行抢占机制
- ......

`k8s.io/kubernetes/pkg/scheduler/scheduler.go:516`

```
func (sched *Scheduler) scheduleOne() {
    ......
    scheduleResult, err := sched.schedule(pod, pluginContext)
    // predicates 算法和 priorities 算法执行失败
    if err != nil {
        if fitError, ok := err.(*core.FitError); ok {
            // 是否开启抢占机制
            if sched.DisablePreemption {
                .......
            } else {
            	// 执行抢占机制
                preemptionStartTime := time.Now()
                sched.preempt(pluginContext, fwk, pod, fitError)
                ......
            }
            ......
        } else {
            ......
        }
        return
    }
    ......
}
```



我们主要来看其中的抢占机制，`sched.preempt()` 是执行抢占机制的主逻辑，主要功能有：
- 从 apiserver 获取 pod info
- 调用 `sched.Algorithm.Preempt()`执行抢占逻辑，该函数会返回抢占成功的 node、被抢占的 pods(victims) 以及需要被移除已提名的 pods
- 更新 scheduler 缓存，为抢占者绑定 nodeName，即设定 pod.Status.NominatedNodeName
- 将 pod info 提交到 apiserver
- 删除被抢占的 pods
- 删除被抢占 pods 的 NominatedNodeName 字段



可以看到当上述抢占过程发生时，抢占者并不会立刻被调度到被抢占的 node 上，调度器只会将抢占者的 status.nominatedNodeName 字段设置为被抢占的 node 的名字。然后，抢占者会重新进入下一个调度周期，在新的调度周期里来决定是不是要运行在被抢占的节点上，当然，即使在下一个调度周期，调度器也不会保证抢占者一定会运行在被抢占的节点上。



这样设计的一个重要原因是调度器只会通过标准的 DELETE API 来删除被抢占的 pod，所以，这些 pod 必然是有一定的“优雅退出”时间（默认是 30s）的。而在这段时间里，其他的节点也是有可能变成可调度的，或者直接有新的节点被添加到这个集群中来。所以，鉴于优雅退出期间集群的可调度性可能会发生的变化，把抢占者交给下一个调度周期再处理，是一个非常合理的选择。而在抢占者等待被调度的过程中，如果有其他更高优先级的 pod 也要抢占同一个节点，那么调度器就会清空原抢占者的 status.nominatedNodeName 字段，从而允许更高优先级的抢占者执行抢占，并且，这也使得原抢占者本身也有机会去重新抢占其他节点。以上这些都是设置 `nominatedNodeName` 字段的主要目的。

`k8s.io/kubernetes/pkg/scheduler/scheduler.go:352`
```
func (sched *Scheduler) preempt(pluginContext *framework.PluginContext, fwk framework.Framework, preemptor *v1.Pod, scheduleErr error) (string, error) {
    // 获取 pod info
    preemptor, err := sched.PodPreemptor.GetUpdatedPod(preemptor)
    if err != nil {
        klog.Errorf("Error getting the updated preemptor pod object: %v", err)
        return "", err
    }

    // 执行抢占算法
    node, victims, nominatedPodsToClear, err := sched.Algorithm.Preempt(pluginContext, preemptor, scheduleErr)
    if err != nil {
        ......
    }
    var nodeName = ""
    if node != nil {
        nodeName = node.Name
        // 更新 scheduler 缓存，为抢占者绑定 nodename，即设定 pod.Status.NominatedNodeName
        sched.SchedulingQueue.UpdateNominatedPodForNode(preemptor, nodeName)

        // 将 pod info 提交到 apiserver
        err = sched.PodPreemptor.SetNominatedNodeName(preemptor, nodeName)
        if err != nil {
            sched.SchedulingQueue.DeleteNominatedPodIfExists(preemptor)
            return "", err
        }
        // 删除被抢占的 pods
        for _, victim := range victims {
            if err := sched.PodPreemptor.DeletePod(victim); err != nil {
                return "", err
            }
            ......
        }
    }

    // 删除被抢占 pods 的 NominatedNodeName 字段
    for _, p := range nominatedPodsToClear {
        rErr := sched.PodPreemptor.RemoveNominatedNodeName(p)
        if rErr != nil {
            ......
        }
    }
    return nodeName, err
}
```


`preempt()`中会调用 `sched.Algorithm.Preempt()`来执行实际抢占的算法，其主要功能有：
- 判断 err 是否为 `FitError`
- 调用`podEligibleToPreemptOthers()`确认 pod 是否有抢占其他 pod 的资格，若 pod 已经抢占了低优先级的 pod，被抢占的 pod 处于 terminating 状态中，则不会继续进行抢占
- 如果确定抢占可以发生，调度器会把自己缓存的所有节点信息复制一份，然后使用这个副本来模拟抢占过程
- 过滤预选失败的 node 列表，此处会检查 predicates 失败的原因，若存在 NodeSelectorNotMatch、PodNotMatchHostName 这些 error 则不能成为抢占者，如果过滤出的候选 node 为空则返回抢占者作为 nominatedPodsToClear
- 获取 `PodDisruptionBudget` 对象
- 从预选失败的 node 列表中并发计算可以被抢占的 nodes，得到 `nodeToVictims`
- 若声明了 extenders 则调用 extenders 再次过滤 `nodeToVictims`
- 调用  `pickOneNodeForPreemption()` 从 `nodeToVictims` 中选出一个节点作为最佳候选人
- 移除低优先级 pod 的 `Nominated`，更新这些 pod，移动到 activeQ 队列中，让调度器为这些 pod 重新 bind node

`k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:320`
```
func (g *genericScheduler) Preempt(pluginContext *framework.PluginContext, pod *v1.Pod, scheduleErr error) (*v1.Node, []*v1.Pod, []*v1.Pod, error) {
    fitError, ok := scheduleErr.(*FitError)
    if !ok || fitError == nil {
        return nil, nil, nil, nil
    }
    // 判断 pod 是否支持抢占，若 pod 已经抢占了低优先级的 pod，被抢占的 pod 处于 terminating 状态中，则不会继续进行抢占
    if !podEligibleToPreemptOthers(pod, g.nodeInfoSnapshot.NodeInfoMap, g.enableNonPreempting) {
        return nil, nil, nil, nil
    }
    // 从缓存中获取 node list
    allNodes := g.cache.ListNodes()
    if len(allNodes) == 0 {
        return nil, nil, nil, ErrNoNodesAvailable
    }
    // 过滤 predicates 算法执行失败的 node 作为抢占的候选 node
    potentialNodes := nodesWherePreemptionMightHelp(allNodes, fitError)
    // 如果过滤出的候选 node 为空则返回抢占者作为 nominatedPodsToClear
    if len(potentialNodes) == 0 {
        return nil, nil, []*v1.Pod{pod}, nil
    }
    // 获取 PodDisruptionBudget objects
    pdbs, err := g.pdbLister.List(labels.Everything())
    if err != nil {
        return nil, nil, nil, err
    }
    // 过滤出可以抢占的 node 列表
    nodeToVictims, err := g.selectNodesForPreemption(pluginContext, pod, g.nodeInfoSnapshot.NodeInfoMap, potentialNodes, g.predicates,
        g.predicateMetaProducer, g.schedulingQueue, pdbs)
    if err != nil {
        return nil, nil, nil, err
    }

    // 若有 extender 则执行
    nodeToVictims, err = g.processPreemptionWithExtenders(pod, nodeToVictims)
    if err != nil {
        return nil, nil, nil, err
    }

    // 选出最佳的 node
    candidateNode := pickOneNodeForPreemption(nodeToVictims)
    if candidateNode == nil {
        return nil, nil, nil, nil
    }

    // 移除低优先级 pod 的 Nominated，更新这些 pod，移动到 activeQ 队列中，让调度器
    // 为这些 pod 重新 bind node
    nominatedPods := g.getLowerPriorityNominatedPods(pod, candidateNode.Name)
    if nodeInfo, ok := g.nodeInfoSnapshot.NodeInfoMap[candidateNode.Name]; ok {
        return nodeInfo.Node(), nodeToVictims[candidateNode].Pods, nominatedPods, nil
    }

    return nil, nil, nil, fmt.Errorf(
        "preemption failed: the target node %s has been deleted from scheduler cache",
        candidateNode.Name)
}
```

该函数中调用了多个函数：
`nodesWherePreemptionMightHelp()`：过滤 predicates 算法执行失败的 node
`selectNodesForPreemption()`：过滤出可以抢占的 node 列表
`pickOneNodeForPreemption()`：选出最佳的 node
`getLowerPriorityNominatedPods()`：移除低优先级 pod 的 Nominated


`selectNodesForPreemption()` 从 prediacates 算法执行失败的 node 列表中来寻找可以被抢占的 node，通过`workqueue.ParallelizeUntil()`并发执行`checkNode()`函数检查 node。

`k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:996`
```
func (g *genericScheduler) selectNodesForPreemption(
   ......
   ) (map[*v1.Node]*schedulerapi.Victims, error) {
    nodeToVictims := map[*v1.Node]*schedulerapi.Victims{}
    var resultLock sync.Mutex

    meta := metadataProducer(pod, nodeNameToInfo)
    // checkNode 函数
    checkNode := func(i int) {
        nodeName := potentialNodes[i].Name
        var metaCopy predicates.PredicateMetadata
        if meta != nil {
            metaCopy = meta.ShallowCopy()
        }
        // 调用 selectVictimsOnNode 函数进行检查
        pods, numPDBViolations, fits := g.selectVictimsOnNode(pluginContext, pod, metaCopy, nodeNameToInfo[nodeName], fitPredicates, queue, pdbs)
        if fits {
            resultLock.Lock()
            victims := schedulerapi.Victims{
                Pods:             pods,
                NumPDBViolations: numPDBViolations,
            }
            nodeToVictims[potentialNodes[i]] = &victims
            resultLock.Unlock()
        }
    }
    // 启动 16 个 goroutine 并发执行
    workqueue.ParallelizeUntil(context.TODO(), 16, len(potentialNodes), checkNode)
    return nodeToVictims, nil
}
```



其中调用的`selectVictimsOnNode()`是来获取每个 node 上 victims pod 的，首先移除所有低优先级的 pod 尝试抢占者是否可以调度成功，如果能够调度成功，然后基于 pod 是否有 PDB 被分为两组 `violatingVictims` 和 `nonViolatingVictims`，再对每一组的  pod 按优先级进行排序。PDB(pod 中断预算)是 kubernetes 保证副本高可用的一个对象。



然后开始逐一”删除“ pod 即要删掉最少的 pod 数来完成这次抢占即可，先从 `violatingVictims`(有PDB)的一组中进行”删除“ pod，并且记录删除有 PDB  pod 的数量，然后再“删除” `nonViolatingVictims` 组中的 pod，每次”删除“一个 pod 都要检查一下抢占者是否能够运行在该 node 上即执行一次预选策略，若执行预选策略失败则该 node 当前不满足抢占需要继续”删除“ pod 并将该 pod 加入到 victims 中，直到”删除“足够多的 pod 可以满足抢占，最后返回 victims 以及删除有 PDB  pod 的数量。

`k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:1086`
```
func (g *genericScheduler) selectVictimsOnNode(
		......
) ([]*v1.Pod, int, bool) {
    if nodeInfo == nil {
        return nil, 0, false
    }

    potentialVictims := util.SortableList{CompFunc: util.MoreImportantPod}
    nodeInfoCopy := nodeInfo.Clone()

    removePod := func(rp *v1.Pod) {
        nodeInfoCopy.RemovePod(rp)
        if meta != nil {
            meta.RemovePod(rp, nodeInfoCopy.Node())
        }
    }
    addPod := func(ap *v1.Pod) {
        nodeInfoCopy.AddPod(ap)
        if meta != nil {
            meta.AddPod(ap, nodeInfoCopy)
        }
    }
    // 先删除所有的低优先级 pod 检查是否能满足抢占 pod 的调度需求
    podPriority := util.GetPodPriority(pod)
    for _, p := range nodeInfoCopy.Pods() {
        if util.GetPodPriority(p) < podPriority {
            potentialVictims.Items = append(potentialVictims.Items, p)
            removePod(p)
        }
    }
    // 如果删除所有低优先级的 pod 不符合要求则直接过滤掉该 node
    // podFitsOnNode 就是前文讲过用来执行预选函数的
    if fits, _, _, err := g.podFitsOnNode(pluginContext, pod, meta, nodeInfoCopy, fitPredicates, queue, false); !fits {
        if err != nil {
						......
        }
        return nil, 0, false
    }
    var victims []*v1.Pod
    numViolatingVictim := 0
    potentialVictims.Sort()

    // 尝试尽量多地“删除”这些 pods，先从 PDB violating victims 中“删除”，再从 PDB non-violating victims 中“删除”
    violatingVictims, nonViolatingVictims := filterPodsWithPDBViolation(potentialVictims.Items, pdbs)

    // reprievePod 是“删除” pods 的函数
    reprievePod := func(p *v1.Pod) bool {
        addPod(p)
        // 同样也会调用 podFitsOnNode 再次执行 predicates 算法
        fits, _, _, _ := g.podFitsOnNode(pluginContext, pod, meta, nodeInfoCopy, fitPredicates, queue, false)
        if !fits {
            removePod(p)
            // 加入到 victims 中
            victims = append(victims, p)
        }
        return fits
    }
     // 删除 violatingVictims 中的 pod，同时也记录删除了多少个
    for _, p := range violatingVictims {
        if !reprievePod(p) {
            numViolatingVictim++
        }
    }
    // 删除 nonViolatingVictims 中的 pod
    for _, p := range nonViolatingVictims {
        reprievePod(p)
    }
    return victims, numViolatingVictim, true
}
```



`pickOneNodeForPreemption()` 用来选出最佳的 node 作为抢占者的 node，该函数主要基于 6 个原则：
- PDB violations 值最小的 node
- 挑选具有高优先级较少的 node
- 对每个 node 上所有 victims 的优先级进项累加，选取最小的
- 如果多个 node 优先级总和相等，选择具有最小 victims  数量的 node
- 如果多个 node 优先级总和相等，选择具有高优先级且 pod 运行时间最短的
- 如果依据以上策略仍然选出了多个 node 则直接返回第一个 node


`k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:867`
```
func pickOneNodeForPreemption(nodesToVictims map[*v1.Node]*schedulerapi.Victims) *v1.Node {
    if len(nodesToVictims) == 0 {
        return nil
    }
    minNumPDBViolatingPods := math.MaxInt32
    var minNodes1 []*v1.Node
    lenNodes1 := 0
    for node, victims := range nodesToVictims {
        if len(victims.Pods) == 0 {
	        // 若该 node 没有 victims 则返回
            return node
        }
        numPDBViolatingPods := victims.NumPDBViolations
        if numPDBViolatingPods < minNumPDBViolatingPods {
            minNumPDBViolatingPods = numPDBViolatingPods
            minNodes1 = nil
            lenNodes1 = 0
        }
        if numPDBViolatingPods == minNumPDBViolatingPods {
            minNodes1 = append(minNodes1, node)
            lenNodes1++
        }
    }
    if lenNodes1 == 1 {
        return minNodes1[0]
    }

    // 选出 PDB violating pods 数量最少的或者高优先级 victim 数量少的
    minHighestPriority := int32(math.MaxInt32)
    var minNodes2 = make([]*v1.Node, lenNodes1)
    lenNodes2 := 0
    for i := 0; i < lenNodes1; i++ {
        node := minNodes1[i]
        victims := nodesToVictims[node]
        highestPodPriority := util.GetPodPriority(victims.Pods[0])
        if highestPodPriority < minHighestPriority {
            minHighestPriority = highestPodPriority
            lenNodes2 = 0
        }
        if highestPodPriority == minHighestPriority {
            minNodes2[lenNodes2] = node
            lenNodes2++
        }
    }
    if lenNodes2 == 1 {
        return minNodes2[0]
    }
    // 若多个 node 高优先级的 pod 同样少，则选出加权得分最小的
    minSumPriorities := int64(math.MaxInt64)
    lenNodes1 = 0
    for i := 0; i < lenNodes2; i++ {
        var sumPriorities int64
        node := minNodes2[i]
        for _, pod := range nodesToVictims[node].Pods {
            sumPriorities += int64(util.GetPodPriority(pod)) + int64(math.MaxInt32+1)
        }
        if sumPriorities < minSumPriorities {
            minSumPriorities = sumPriorities
            lenNodes1 = 0
        }
        if sumPriorities == minSumPriorities {
            minNodes1[lenNodes1] = node
            lenNodes1++
        }
    }
    if lenNodes1 == 1 {
        return minNodes1[0]
    }
    // 若多个 node 高优先级的 pod 数量同等且加权分数相等，则选出 pod 数量最少的
    minNumPods := math.MaxInt32
    lenNodes2 = 0
    for i := 0; i < lenNodes1; i++ {
        node := minNodes1[i]
        numPods := len(nodesToVictims[node].Pods)
        if numPods < minNumPods {
            minNumPods = numPods
            lenNodes2 = 0
        }
        if numPods == minNumPods {
            minNodes2[lenNodes2] = node
            lenNodes2++
        }
    }
    if lenNodes2 == 1 {
        return minNodes2[0]
    }
    // 若多个 node 的 pod 数量相等，则选出高优先级 pod 启动时间最短的
    latestStartTime := util.GetEarliestPodStartTime(nodesToVictims[minNodes2[0]])
    if latestStartTime == nil {
        return minNodes2[0]
    }
    nodeToReturn := minNodes2[0]
    for i := 1; i < lenNodes2; i++ {
        node := minNodes2[i]
        earliestStartTimeOnNode := util.GetEarliestPodStartTime(nodesToVictims[node])
        if earliestStartTimeOnNode == nil {
            klog.Errorf("earliestStartTime is nil for node %s. Should not reach here.", node)
            continue
        }
        if earliestStartTimeOnNode.After(latestStartTime.Time) {
            latestStartTime = earliestStartTimeOnNode
            nodeToReturn = node
        }
    }

    return nodeToReturn
}
```

以上就是对抢占机制代码的一个通读。



### 优先级与抢占机制的使用



1、创建 PriorityClass 对象：

```
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000000
globalDefault: false
description: "This priority class should be used for XYZ service pods only."
```



2、在 deployment、statefulset 或者 pod 中声明使用已有的 priorityClass 对象即可

在 pod 中使用：

 ```
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: nginx-a
  name: nginx-a
spec:
  containers:
  - image: nginx:1.7.9
    imagePullPolicy: IfNotPresent
    name: nginx-a
    ports:
    - containerPort: 80
      protocol: TCP
    resources:
      requests:
        memory: "64Mi"
        cpu: 5
      limits:
        memory: "128Mi"
        cpu: 5
  priorityClassName: high-priority
 ```

在 deployment 中使用：

```
  template:
    spec:
      containers:
      - image: nginx
        name: nginx-deployment
        priorityClassName: high-priority
```

3、测试过程中可以看到高优先级的 nginx-a 会抢占 nginx-5754944d6c 的资源：

```
$ kubectl get pod -o  wide -w
NAME                     READY   STATUS    RESTARTS   AGE   IP           NODE          NOMINATED NODE   READINESS GATES
nginx-5754944d6c-9mnxa   1/1     Running   0          37s   10.244.1.4   test-worker   <none>           <none>
nginx-a                  0/1     Pending   0          0s    <none>       <none>        <none>           <none>
nginx-a                  0/1     Pending   0          0s    <none>       <none>        <none>           <none>
nginx-a                  0/1     Pending   0          0s    <none>       <none>        test-worker      <none>
nginx-5754944d6c-9mnxa   1/1     Terminating   0          45s   10.244.1.4   test-worker   <none>           <none>
nginx-5754944d6c-9mnxa   0/1     Terminating   0          46s   10.244.1.4   test-worker   <none>           <none>
nginx-5754944d6c-9mnxa   0/1     Terminating   0          47s   10.244.1.4   test-worker   <none>           <none>
nginx-5754944d6c-9mnxa   0/1     Terminating   0          47s   10.244.1.4   test-worker   <none>           <none>
nginx-a                  0/1     Pending       0          2s    <none>       test-worker   test-worker      <none>
nginx-a                  0/1     ContainerCreating   0          2s    <none>       test-worker   <none>           <none>
nginx-a                  1/1     Running             0          4s    10.244.1.5   test-worker   <none>           <none>
```



### 总结

这篇文章主要讲述 kube-scheduler 中的优先级与抢占机制，可以看到抢占机制比 predicates 与 priorities 算法都要复杂，其中的许多细节仍然没有提到，本文只是通读了大部分代码，某些代码的实现需要精读，限于笔者时间的关系，对于 kube-scheduler 的代码暂时分享到此处。



参考：

https://kubernetes.io/docs/concepts/configuration/pod-priority-preemption/

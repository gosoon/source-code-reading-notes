---
title: kube-scheduler predicates 与 priorities 调度算法源码分析
date: 2019-10-22 19:30:30
tags: ["kube-scheduler","algorithm"]
type: "kube-scheduler"

---

在上篇文章[kube-scheduler 源码分析](http://blog.tianfeiyu.com/2019/10/21/kube_scheduler_process/)中已经介绍了 kube-scheduler 的设计以及从源码角度分析了其执行流程，这篇文章会专注介绍调度过程中 predicates 和 priorities 这两个调度策略主要发生作用的阶段。

> kubernetes 版本: v1.16

### predicates 调度算法源码分析

predicates 算法主要是对集群中的 node 进行过滤，选出符合当前 pod 运行的 nodes。



#### 调度算法说明 

上节已经提到默认的调度算法在`pkg/scheduler/algorithmprovider/defaults/defaults.go`中定义了：

```
func defaultPredicates() sets.String {
    return sets.NewString(
        predicates.NoVolumeZoneConflictPred,
        predicates.MaxEBSVolumeCountPred,
        predicates.MaxGCEPDVolumeCountPred,
        predicates.MaxAzureDiskVolumeCountPred,
        predicates.MaxCSIVolumeCountPred,
        predicates.MatchInterPodAffinityPred,
        predicates.NoDiskConflictPred,
        predicates.GeneralPred,
        predicates.CheckNodeMemoryPressurePred,
        predicates.CheckNodeDiskPressurePred,
        predicates.CheckNodePIDPressurePred,
        predicates.CheckNodeConditionPred,
        predicates.PodToleratesNodeTaintsPred,
        predicates.CheckVolumeBindingPred,
    )
}
```



下面是对默认调度算法的一些说明：

| predicates 算法             | 说明                                                         |
| --------------------------- | ------------------------------------------------------------ |
| GeneralPred                 | GeneralPred 包含 PodFitsResources、PodFitsHost,、PodFitsHostPorts、PodMatchNodeSelector 四种算法 |
| NoDiskConflictPred          | 检查多个 Pod 声明挂载的持久化 Volume 是否有冲突              |
| MaxGCEPDVolumeCountPred     | 检查 GCE 持久化 Volume 是否超过了一定数目                    |
| MaxAzureDiskVolumeCountPred | 检查 Azure 持久化 Volume 是否超过了一定数目                  |
| MaxCSIVolumeCountPred       | 检查 CSI 持久化 Volume 是否超过了一定数目（已废弃）          |
| MaxEBSVolumeCountPred       | 检查 EBS 持久化 Volume 是否超过了一定数目                    |
| NoVolumeZoneConflictPred    | 检查持久化 Volume 的 Zone（高可用域）标签是否与节点的 Zone 标签相匹配 |
| CheckVolumeBindingPred      | 检查该 Pod 对应 PV 的 nodeAffinity 字段是否跟某个节点的标签相匹配，Local Persistent Volume(本地持久化卷)必须使用 nodeAffinity 来跟某个具体的节点绑定 |
| PodToleratesNodeTaintsPred  | 检查 Node 的 Taint 机制，只有当 Pod 的 Toleration 字段与 Node 的 Taint 字段能够匹配时，这个 Pod 才能被调度到该节点上 |
| MatchInterPodAffinityPred   | 检查待调度 Pod 与 Node 上的已有 Pod 之间的亲密（affinity）和反亲密（anti-affinity）关系 |
| CheckNodeConditionPred      | 检查 NodeCondition                                           |
| CheckNodePIDPressurePred    | 检查 NodePIDPressure                                         |
| CheckNodeDiskPressurePred   | 检查 NodeDiskPressure                                        |
| CheckNodeMemoryPressurePred | 检查 NodeMemoryPressure                                      |

默认的 predicates 调度算法主要分为五种类型：

1、第一种类型叫作 GeneralPredicates，包含 PodFitsResources、PodFitsHost、PodFitsHostPorts、PodMatchNodeSelector 四种策略，其具体含义如下所示：

- PodFitsHost：检查宿主机的名字是否跟 Pod 的 spec.nodeName 一致
- PodFitsHostPorts：检查 Pod 申请的宿主机端口（spec.nodePort）是不是跟已经被使用的端口有冲突
- PodMatchNodeSelector：检查 Pod 的 nodeSelector 或者 nodeAffinity 指定的节点是否与节点匹配等
- PodFitsResources：检查主机的资源是否满足 Pod 的需求，根据实际已经分配（Request）的资源量做调度       

kubelet 在启动 Pod 前，会执行一个 Admit 操作来进行二次确认，这里二次确认的规则就是执行一遍 GeneralPredicates。

2、第二种类型是与 Volume 相关的过滤规则，主要有NoDiskConflictPred、MaxGCEPDVolumeCountPred、MaxAzureDiskVolumeCountPred、MaxCSIVolumeCountPred、MaxEBSVolumeCountPred、NoVolumeZoneConflictPred、CheckVolumeBindingPred。

3、第三种类型是宿主机相关的过滤规则，主要是 PodToleratesNodeTaintsPred。

4、第四种类型是 Pod 相关的过滤规则，主要是 MatchInterPodAffinityPred。

5、第五种类型是新增的过滤规则，与宿主机的运行状况有关，主要有 CheckNodeCondition、 CheckNodeMemoryPressure、CheckNodePIDPressure、CheckNodeDiskPressure 四种。若启用了 `TaintNodesByCondition FeatureGates` 则在 predicates 算法中会将该四种算法移除，`TaintNodesByCondition` 基于 [node conditions](https://kubernetes.io/docs/concepts/architecture/nodes/#condition) 当 node 出现 pressure 时自动为 node 打上 taints 标签，该功能在 v1.8 引入，v1.12 成为 beta 版本，目前 v1.16 中也是 beta 版本，但在 v1.13 中该功能已默认启用。


predicates 调度算法也有一个顺序，要不然在一台资源已经严重不足的宿主机上，上来就开始计算 PodAffinityPredicate 是没有实际意义的，其默认顺序如下所示：

`k8s.io/kubernetes/pkg/scheduler/algorithm/predicates/predicates.go:146`

```
var (
    predicatesOrdering = []string{CheckNodeConditionPred, CheckNodeUnschedulablePred,
        GeneralPred, HostNamePred, PodFitsHostPortsPred,
        MatchNodeSelectorPred, PodFitsResourcesPred, NoDiskConflictPred,
        PodToleratesNodeTaintsPred, PodToleratesNodeNoExecuteTaintsPred, CheckNodeLabelPresencePred,
        CheckServiceAffinityPred, MaxEBSVolumeCountPred, MaxGCEPDVolumeCountPred, MaxCSIVolumeCountPred,
        MaxAzureDiskVolumeCountPred, MaxCinderVolumeCountPred, CheckVolumeBindingPred, NoVolumeZoneConflictPred,
        CheckNodeMemoryPressurePred, CheckNodePIDPressurePred, CheckNodeDiskPressurePred, EvenPodsSpreadPred, MatchInterPodAffinityPred}
)
```



#### 源码分析

上节中已经说到调用预选以及优选算法的逻辑在 `k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:189`中，

```
func (g *genericScheduler) Schedule(pod *v1.Pod, pluginContext *framework.PluginContext) (result ScheduleResult, err error) {
    ......
		
    // 执行 predicates 策略
    filteredNodes, failedPredicateMap, filteredNodesStatuses, err := g.findNodesThatFit(pluginContext, pod)
    
    ......

    // 执行 priorities 策略
    priorityList, err := PrioritizeNodes(pod, g.nodeInfoSnapshot.NodeInfoMap, metaPrioritiesInterface, g.prioritizers, filteredNodes, g.extenders, g.framework,        pluginContext)
    
    ......
    
    return
}
```

`findNodesThatFit()` 是 predicates 策略的实际调用方法，其基本流程如下：
- 设定最多需要检查的节点数，作为预选节点数组的容量，避免总节点过多影响调度效率
- 通过`NodeTree()`不断获取下一个节点来判断该节点是否满足 pod 的调度条件
- 通过之前注册的各种 predicates 函数来判断当前节点是否符合 pod 的调度条件
- 最后返回满足调度条件的 node 列表，供下一步的优选操作



`checkNode()`是一个校验 node 是否符合要求的函数，其实际调用到的核心函数是`podFitsOnNode()`，再通过`workqueue()` 并发执行`checkNode()` 函数，`workqueue()` 会启动 16 个 goroutine 来并行计算需要筛选的 node 列表，其主要流程如下：
- 通过 cache 中的 `NodeTree()` 不断获取下一个 node
- 将当前 node 和 pod 传入`podFitsOnNode()` 方法中来判断当前 node 是否符合要求
- 如果当前 node 符合要求就将当前 node 加入预选节点的数组中`filtered`
- 如果当前 node 不满足要求，则加入到失败的数组中，并记录原因
- 通过`workqueue.ParallelizeUntil()`并发执行`checkNode()`函数，一旦找到足够的可行节点数后就停止筛选更多节点 
- 若配置了 extender 则再次进行过滤已筛选出的 node

`k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:464`
```
func (g *genericScheduler) findNodesThatFit(pluginContext *framework.PluginContext, pod *v1.Pod) ([]*v1.Node, FailedPredicateMap, framework.NodeToStatusMap, error) {
	var filtered []*v1.Node
	failedPredicateMap := FailedPredicateMap{}
	filteredNodesStatuses := framework.NodeToStatusMap{}

	if len(g.predicates) == 0 {
		filtered = g.cache.ListNodes()
	} else {
		allNodes := int32(g.cache.NodeTree().NumNodes())
		// 1.设定最多需要检查的节点数
		numNodesToFind := g.numFeasibleNodesToFind(allNodes)

		filtered = make([]*v1.Node, numNodesToFind)
		......
		
		// 2.获取该 pod 的 meta 值 
		meta := g.predicateMetaProducer(pod, g.nodeInfoSnapshot.NodeInfoMap)

		// 3.checkNode 为执行预选算法的函数
		checkNode := func(i int) {
			nodeName := g.cache.NodeTree().Next()

			// 4.podFitsOnNode 最终执行预选算法的函数 
			fits, failedPredicates, status, err := g.podFitsOnNode(
				......
			)
			if err != nil {
				......
			}
			if fits {
				length := atomic.AddInt32(&filteredLen, 1)
				if length > numNodesToFind {
					cancel()
					atomic.AddInt32(&filteredLen, -1)
				} else {
					filtered[length-1] = g.nodeInfoSnapshot.NodeInfoMap[nodeName].Node()
				}
			} else {
				......
			}
		}

		// 5.启动 16 个 goroutine 并发执行 checkNode 函数
		workqueue.ParallelizeUntil(ctx, 16, int(allNodes), checkNode)

		filtered = filtered[:filteredLen]
		if len(errs) > 0 {
			......
		}
	}

	// 6.若配置了 extender 则再次进行过滤
	if len(filtered) > 0 && len(g.extenders) != 0 {
		......
	}
	return filtered, failedPredicateMap, filteredNodesStatuses, nil
}
```

然后继续看如何设定最多需要检查的节点数，此过程由`numFeasibleNodesToFind()`进行处理，基本流程如下：

- 如果总的 node 节点小于`minFeasibleNodesToFind`(默认为100)则直接返回总节点数
- 如果节点数超过 100，则取指定百分比 `percentageOfNodesToScore`(默认值为 50)的节点数 ，当该百分比后的数目仍小于`minFeasibleNodesToFind`，则返回`minFeasibleNodesToFind`
- 如果百分比后的数目大于`minFeasibleNodesToFind`，则返回该百分比的节点数

所以当节点数小于 100 时直接返回，大于 100 时只返回其总数的 50%。`percentageOfNodesToScore` 参数在 v1.12 引入，默认值为 50，kube-scheduler 在启动时可以设定该参数的值。

`k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:441`
```
func (g *genericScheduler) numFeasibleNodesToFind(numAllNodes int32) (numNodes int32) {
    if numAllNodes < minFeasibleNodesToFind || g.percentageOfNodesToScore >= 100 {
        return numAllNodes
    }

    adaptivePercentage := g.percentageOfNodesToScore
    if adaptivePercentage <= 0 {
        adaptivePercentage = schedulerapi.DefaultPercentageOfNodesToScore - numAllNodes/125
        if adaptivePercentage < minFeasibleNodesPercentageToFind {
            adaptivePercentage = minFeasibleNodesPercentageToFind
        }
    }

    numNodes = numAllNodes * adaptivePercentage / 100
    if numNodes < minFeasibleNodesToFind {
        return minFeasibleNodesToFind
    }

    return numNodes
}
```

pridicates 调度算法的核心是 `podFitsOnNode()` ，scheduler 的抢占机制也会执行该函数，`podFitsOnNode()`基本流程如下：
- 遍历已经注册好的预选策略`predicates.Ordering()`，按顺序执行对应的策略函数
- 遍历执行每个策略函数，并返回是否合适，预选失败的原因和错误
- 如果预选函数执行失败，则加入预选失败的数组中，直接返回，后面的预选函数不会再执行
- 如果该 node 上存在 nominated pod 则执行两次预选函数


因为引入了抢占机制，此处主要说明一下执行两次预选函数的原因：

第一次循环，若该 pod 为抢占者(`nominatedPods`)，调度器会假设该 pod 已经运行在这个节点上，然后更新`meta`和`nodeInfo`，`nominatedPods`是指执行了抢占机制且已经分配到了 node(`pod.Status.NominatedNodeName` 已被设定) 但是还没有真正运行起来的 pod，然后再执行所有的预选函数。

第二次循环，不将`nominatedPods`加入到 node 内。

而只有这两遍 predicates 算法都能通过时，这个 pod 和 node 才会被认为是可以绑定(bind)的。这样做是因为考虑到 pod affinity 等策略的执行，如果当前的 pod 与`nominatedPods`有依赖关系就会有问题，因为`nominatedPods`不能保证一定可以调度且在已指定的 node 运行成功，也可能出现被其他高优先级的 pod 抢占等问题，关于抢占问题下篇会详细介绍。

`k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:610`
```
func (g *genericScheduler) podFitsOnNode(......) (bool, []predicates.PredicateFailureReason, *framework.Status, error) {
    var failedPredicates []predicates.PredicateFailureReason
    var status *framework.Status

    podsAdded := false

    for i := 0; i < 2; i++ {
        metaToUse := meta
        nodeInfoToUse := info
        if i == 0 {
            // 1.第一次循环加入 NominatedPods，计算 meta, nodeInfo
            podsAdded, metaToUse, nodeInfoToUse = addNominatedPods(pod, meta, info, queue)
        } else if !podsAdded || len(failedPredicates) != 0 {
            break
        }
        // 2.按顺序执行所有预选函数
        for _, predicateKey := range predicates.Ordering() {
            var (
                fit     bool
                reasons []predicates.PredicateFailureReason
                err     error
            )
            if predicate, exist := predicateFuncs[predicateKey]; exist {
                fit, reasons, err = predicate(pod, metaToUse, nodeInfoToUse)
                if err != nil {
                    return false, []predicates.PredicateFailureReason{}, nil, err
                }
								
                // 3.任何一个预选函数执行失败则直接返回
                if !fit {
                    failedPredicates = append(failedPredicates, reasons...)                   
                    if !alwaysCheckAllPredicates {
                        klog.V(5).Infoln("since alwaysCheckAllPredicates has not been set, the predicate " +
                            "evaluation is short circuited and there are chances " +
                            "of other predicates failing as well.")
                        break
                    }
                }
            }
        }
        // 4.执行 Filter Plugin
        status = g.framework.RunFilterPlugins(pluginContext, pod, info.Node().Name)
        if !status.IsSuccess() && !status.IsUnschedulable() {
            return false, failedPredicates, status, status.AsError()
        }
    }

    return len(failedPredicates) == 0 && status.IsSuccess(), failedPredicates, status, nil
}
```

至此，关于 predicates 调度算法的执行过程已经分析完。



### priorities 调度算法源码分析

priorities  调度算法是在 pridicates 算法后执行的，主要功能是对已经过滤出的 nodes 进行打分并选出最佳的一个 node。

#### 调度算法说明

默认的调度算法在`pkg/scheduler/algorithmprovider/defaults/defaults.go`中定义了：

```
func defaultPriorities() sets.String {
    return sets.NewString(
        priorities.SelectorSpreadPriority,
        priorities.InterPodAffinityPriority,
        priorities.LeastRequestedPriority,
        priorities.BalancedResourceAllocation,
        priorities.NodePreferAvoidPodsPriority,
        priorities.NodeAffinityPriority,
        priorities.TaintTolerationPriority,
        priorities.ImageLocalityPriority,
    )
}
```

默认调度算法的一些说明：

| priorities 算法             | 说明                                                         |
| --------------------------- | ------------------------------------------------------------ |
| SelectorSpreadPriority      | 按 service，rs，statefulset 归属计算 Node 上分布最少的同类 Pod数量，数量越少得分越高，默认权重为1 |
| InterPodAffinityPriority    | pod 亲和性选择策略，默认权重为1                              |
| LeastRequestedPriority      | 选择空闲资源（CPU 和 Memory）最多的节点，默认权重为1，其计算方式为：score = (cpu((capacity-sum(requested))10/capacity) + memory((capacity-sum(requested))10/capacity))/2 |
| BalancedResourceAllocation  | CPU、Memory 以及 Volume 资源分配最均衡的节点，默认权重为1，其计算方式为：score = 10 - variance(cpuFraction,memoryFraction,volumeFraction)*10 |
| NodePreferAvoidPodsPriority | 判断 node annotation 是否有scheduler.alpha.kubernetes.io/preferAvoidPods 标签，类似于 taints 机制，过滤标签中定义类型的 pod，默认权重为10000 |
| NodeAffinityPriority        | 节点亲和性选择策略，默认权重为1                              |
| TaintTolerationPriority     | Pod 是否容忍节点上的 Taint，优先调度到标记了 Taint 的节点，默认权重为1 |
| ImageLocalityPriority       | 待调度 Pod 需要使用的镜像是否存在于该节点，默认权重为1       |



#### 源码分析

执行 priorities 调度算法的逻辑是在 `PrioritizeNodes()`函数中，其目的是执行每个 priority 函数为 node 打分，分数为 0-10，其功能主要有：

- `PrioritizeNodes()` 通过并行运行各个优先级函数来对节点进行打分
- 每个优先级函数会给节点打分，打分范围为 0-10 分，0 表示优先级最低的节点，10表示优先级最高的节点
- 每个优先级函数有各自的权重
- 优先级函数返回的节点分数乘以权重以获得加权分数
- 最后计算所有节点的总加权分数

`k8s.io/kubernetes/pkg/scheduler/core/generic_scheduler.go:691`
```
func PrioritizeNodes(......) (schedulerapi.HostPriorityList, error) {
    // 1.检查是否有自定义配置
    if len(priorityConfigs) == 0 && len(extenders) == 0 {
        result := make(schedulerapi.HostPriorityList, 0, len(nodes))
        for i := range nodes {
            hostPriority, err := EqualPriorityMap(pod, meta, nodeNameToInfo[nodes[i].Name])
            if err != nil {
                return nil, err
            }
            result = append(result, hostPriority)
        }
        return result, nil
    }
	......

    results := make([]schedulerapi.HostPriorityList, len(priorityConfigs), len(priorityConfigs))

    ......
    // 2.使用 workqueue 启动 16 个 goroutine 并发为 node 打分
    workqueue.ParallelizeUntil(context.TODO(), 16, len(nodes), func(index int) {
        nodeInfo := nodeNameToInfo[nodes[index].Name]
        for i := range priorityConfigs {
            if priorityConfigs[i].Function != nil {
                continue
            }

            var err error
            results[i][index], err = priorityConfigs[i].Map(pod, meta, nodeInfo)
            if err != nil {
                appendError(err)
                results[i][index].Host = nodes[index].Name
            }
        }
    })

    // 3.执行自定义配置
    for i := range priorityConfigs {
        ......
    }
    
    wg.Wait()
    if len(errs) != 0 {
        return schedulerapi.HostPriorityList{}, errors.NewAggregate(errs)
    }

    // 4.运行 Score plugins
    scoresMap, scoreStatus := framework.RunScorePlugins(pluginContext, pod, nodes)
    if !scoreStatus.IsSuccess() {
        return schedulerapi.HostPriorityList{}, scoreStatus.AsError()
    }
    
    result := make(schedulerapi.HostPriorityList, 0, len(nodes))
    // 5.为每个 node 汇总分数
    for i := range nodes {
        result = append(result, schedulerapi.HostPriority{Host: nodes[i].Name, Score: 0})
        for j := range priorityConfigs {
            result[i].Score += results[j][i].Score * priorityConfigs[j].Weight
        }

        for j := range scoresMap {
            result[i].Score += scoresMap[j][i].Score
        }
    }
    
    // 6.执行 extender 
    if len(extenders) != 0 && nodes != nil {
        ......
    }
    ......
    return result, nil
}
```


### 总结

本文主要讲述了 kube-scheduler 中的 predicates 调度算法与 priorities 调度算法的执行流程，可以看到 kube-scheduler 中有许多的调度策略，但是想要添加自己的策略并不容易，scheduler 目前已经朝着提升性能与扩展性的方向演进了，其调度部分进行性能优化的一个最根本原则就是尽最大可能将集群信息 cache 化，以便从根本上提高 predicates 和 priorities 调度算法的执行效率。第二个就是在 bind 阶段进行异步处理，只会更新其 cache 里的 pod 和 node 的信息，这种基于“乐观”假设的 API 对象更新方式，在 kubernetes 里被称作 assume，如果这次异步的 bind 过程失败了，其实也没有太大关系，等 scheduler cache 同步之后一切又恢复正常了。除了上述的“cache 化”和“乐观绑定”，还有一个重要的设计，那就是“无锁化”，predicates 调度算法与 priorities 调度算法的执行都是并行的，只有在调度队列和 scheduler cache 进行操作时，才需要加锁，而对调度队列的操作并不影响主流程。



参考：

https://kubernetes.io/docs/concepts/configuration/scheduling-framework/

[predicates-ordering.md](https://github.com/kubernetes/community/blob/master/contributors/design-proposals/scheduling/predicates-ordering.md)


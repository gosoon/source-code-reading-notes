---
title: NodeController 源码分析
date: 2020-01-09 20:18:30
tags: ["kube-controller-manager","node controller"]
type: "node controller"

---

* [NodeLifecycleController 的功能](#nodelifecyclecontroller-的功能)
   * [taint 的作用](#taint-的作用)
   * [NodeLifecycleController 中的 feature-gates](#nodelifecyclecontroller-中的-feature-gates)
* [NodeLifecycleController 源码分析](#nodelifecyclecontroller-源码分析)
   * [startNodeLifecycleController](#startnodelifecyclecontroller)
   * [NewNodeLifecycleController](#newnodelifecyclecontroller)
   * [Run](#run)
   * [nc.taintManager.Run](#nctaintmanagerrun)
      * [tc.worker](#tcworker)
         * [tc.handleNodeUpdate](#tchandlenodeupdate)
         * [tc.handlePodUpdate](#tchandlepodupdate)
         * [tc.processPodOnNode](#tcprocesspodonnode)
   * [nc.doNodeProcessingPassWorker](#ncdonodeprocessingpassworker)
   * [nc.doNoExecuteTaintingPass](#ncdonoexecutetaintingpass)
   * [nc.doEvictionPass](#ncdoevictionpass)
   * [nc.monitorNodeHealth](#ncmonitornodehealth)
      * [nc.tryUpdateNodeHealth](#nctryupdatenodehealth)
      * [nc.handleDisruption](#nchandledisruption)
         * [nc.computeZoneStateFunc](#nccomputezonestatefunc)
         * [nc.setLimiterInZone](#ncsetlimiterinzone)
      * [小结](#小结)
* [总结](#总结)


在早期的版本中 NodeController 只有一种，v1.16 版本中 NodeController 已经分为了 NodeIpamController 与 NodeLifecycleController，本文主要介绍 NodeLifecycleController。



### NodeLifecycleController 的功能

NodeLifecycleController 主要功能是定期监控 node 的状态并根据 node 的 condition 添加对应的 taint 标签或者直接驱逐 node 上的 pod。


#### taint 的作用

在介绍 NodeLifecycleController 的源码前有必要先介绍一下 taint 的作用，因为 NodeLifecycleController 功能最终的结果有很大一部分都体现在 node taint 上。 

taint 使用效果(Effect):

- `PreferNoSchedule`：调度器尽量避免把 pod 调度到具有该污点的节点上，如果不能避免(如其他节点资源不足)，pod 也能调度到这个污点节点上，已存在于此节点上的 pod 不会被驱逐；
- `NoSchedule`：不容忍该污点的 pod 不会被调度到该节点上，通过 kubelet 管理的 pod(static pod)不受限制，之前没有设置污点的 pod 如果已运行在此节点(有污点的节点)上，可以继续运行；
- `NoExecute`：不容忍该污点的 pod 不会被调度到该节点上，同时会将已调度到该节点上但不容忍 node 污点的 pod 驱逐掉；



#### NodeLifecycleController 中的 feature-gates

在 NodeLifecycleController 用到了多个 feature-gates，此处先进行解释下：
- `NodeLease` ：该特性在 v1.12 引入，v1.14 为 Beta 版本并默认启用，在 v1.17 中 GA；
- `NodeDisruptionExclusion`：该特性在 v1.16 引入，Alpha 版本，默认为 false，其功能是当 node 存在 `node.kubernetes.io/exclude-disruption` 标签时，当 node 网络中断时其节点上的 pod 不会被驱逐掉；
- `LegacyNodeRoleBehavior`：该特性在 v1.16 中引入，Alpha 版本且默认为 true，在创建 load balancers 以及中断处理时不会忽略具有 `node-role.kubernetes.io/master` label 的 node，该功能在 v1.19 中将被移除；
- `TaintBasedEvictions`：该特性从 v1.13 开始为 Beta 版本，默认为 true。其功能是当 node 处于 `NodeNotReady`、`NodeUnreachable` 状态时为 node 添加对应的 taint，`TaintBasedEvictions` 添加的 taint effect 为 `NoExecute`，即会驱逐 node 上对应的 pod；
- `TaintNodesByCondition`：该特性从 v1.12 开始为 Beta 版本，默认为 true，v1.17 为 GA 版本。其功能是基于节点状态添加 taint，当节点处于 `NetworkUnavailable`、`MemoryPressure`、`PIDPressure`、`DiskPressure` 状态时会添加对应的 taint，`TaintNodesByCondition` 添加的 taint  effect 仅为`NoSchedule`，即仅仅不会让新创建的 pod 调度到该 node 上；     
- `NodeLease`：该特性在 v1.12 引入，v 1.14 为 Beta 版本且默认启用，v 1.17 GA，主要功能是减少 node 的心跳请求以减轻 apiserver 的负担；              



### NodeLifecycleController 源码分析

> kubernetes 版本：v1.16


#### startNodeLifecycleController

首先还是看 NodeLifecycleController 的启动方法 `startNodeLifecycleController`，在 `startNodeLifecycleController` 中主要调用了 `lifecyclecontroller.NewNodeLifecycleController` 对 lifecycleController 进行初始化，在该方法中传入了组件的多个参数以及 `TaintBasedEvictions` 和 `TaintNodesByCondition` 两个 feature-gates，然后调用了 `lifecycleController.Run` 启动 lifecycleController，可以看到 NodeLifecycleController 主要监听 lease、pods、nodes、daemonSets 四种对象。



其中在启动时指定的几个参数默认值分别为：
- `NodeMonitorPeriod`：通过`--node-monitor-period` 设置，默认为 5s，表示在 NodeController 中同步NodeStatus 的周期；
- `NodeStartupGracePeriod`：`--node-startup-grace-period` 默认 60s，在 node 启动完成前标记节点为unhealthy 的允许无响应时间；
- `NodeMonitorGracePeriod`：通过`--node-monitor-grace-period` 设置，默认 40s，表示在标记某个 node为 unhealthy 前，允许 40s 内该 node 无响应；
- `PodEvictionTimeout`：通过`--pod-eviction-timeout` 设置，默认 5 分钟，表示在强制删除 node 上的 pod 时，容忍 pod 时间；
- `NodeEvictionRate`：通过`--node-eviction-rate`设置， 默认 0.1，表示当集群下某个 zone 为 unhealthy 时，每秒应该剔除的 node 数量，默认即每 10s 剔除1个 node；
- `SecondaryNodeEvictionRate`：通过 `--secondary-node-eviction-rate`设置，默认为 0.01，表示如果某个 zone 下的 unhealthy 节点的百分比超过 `--unhealthy-zone-threshold` （默认为 0.55）时，驱逐速率将会减小，如果集群较小（小于等于 `--large-cluster-size-threshold` 个 节点 - 默认为 50），驱逐操作将会停止，否则驱逐速率将降为每秒 `--secondary-node-eviction-rate` 个（默认为 0.01）；
- `LargeClusterSizeThreshold`：通过`--large-cluster-size-threshold` 设置，默认为 50，当该 zone 的节点超过该阈值时，则认为该 zone 是一个大集群；
- `UnhealthyZoneThreshold`：通过`--unhealthy-zone-threshold` 设置，默认为 0.55，不健康 zone 阈值，会影响什么时候开启二级驱赶速率，即当该 zone 中节点宕机数目超过 55%，认为该 zone 不健康；
- `EnableTaintManager`：`--enable-taint-manager` 默认为 true，Beta feature，如果为 true，则表示NodeController 将会启动 TaintManager，当已经调度到该 node 上的 pod 不能容忍 node 的 taint 时，由 TaintManager 负责驱逐此类 pod，若不开启该特性则已调度到该 node 上的 pod 会继续存在；
- `TaintBasedEvictions` ：默认为 true；
- `TaintNodesByCondition` ：默认为 true；



`k8s.io/kubernetes/cmd/kube-controller-manager/app/core.go:163`

```
func startNodeLifecycleController(ctx ControllerContext) (http.Handler, bool, error) {
    lifecycleController, err := lifecyclecontroller.NewNodeLifecycleController(
        ctx.InformerFactory.Coordination().V1beta1().Leases(),
        ctx.InformerFactory.Core().V1().Pods(),
        ctx.InformerFactory.Core().V1().Nodes(),
        ctx.InformerFactory.Apps().V1().DaemonSets(),
        ctx.ClientBuilder.ClientOrDie("node-controller"),
        ctx.ComponentConfig.KubeCloudShared.NodeMonitorPeriod.Duration,
        ctx.ComponentConfig.NodeLifecycleController.NodeStartupGracePeriod.Duration,
        ctx.ComponentConfig.NodeLifecycleController.NodeMonitorGracePeriod.Duration,
        ctx.ComponentConfig.NodeLifecycleController.PodEvictionTimeout.Duration,
        ctx.ComponentConfig.NodeLifecycleController.NodeEvictionRate,
        ctx.ComponentConfig.NodeLifecycleController.SecondaryNodeEvictionRate,
        ctx.ComponentConfig.NodeLifecycleController.LargeClusterSizeThreshold,
        ctx.ComponentConfig.NodeLifecycleController.UnhealthyZoneThreshold,
        ctx.ComponentConfig.NodeLifecycleController.EnableTaintManager,
        utilfeature.DefaultFeatureGate.Enabled(features.TaintBasedEvictions),
        utilfeature.DefaultFeatureGate.Enabled(features.TaintNodesByCondition),
    )
    if err != nil {
        return nil, true, err
    }
    go lifecycleController.Run(ctx.Stop)
    return nil, true, nil
}
```



#### NewNodeLifecycleController

首先有必要说明一下 NodeLifecycleController 对象中部分字段的意义，其结构体如下所示：

```
type Controller struct {
    taintManager *scheduler.NoExecuteTaintManager

    podInformerSynced cache.InformerSynced
    kubeClient        clientset.Interface

    now func() metav1.Time

    // 计算 zone 下 node 驱逐速率
    enterPartialDisruptionFunc func(nodeNum int) float32
    enterFullDisruptionFunc    func(nodeNum int) float32
    
    // 计算 zone 状态
    computeZoneStateFunc       func(nodeConditions []*v1.NodeCondition) (int, ZoneState)

    // 用来记录NodeController observed节点的集合
    knownNodeSet map[string]*v1.Node
    // 记录 node 最近一次状态的集合
    nodeHealthMap map[string]*nodeHealthData

    evictorLock sync.Mutex

    // 需要驱逐节点上 pod 的 node 队列 
    zonePodEvictor map[string]*scheduler.RateLimitedTimedQueue

    // 需要打 taint 标签的 node 队列
    zoneNoExecuteTainter map[string]*scheduler.RateLimitedTimedQueue

    // 将 node 划分为不同的 zone
    zoneStates map[string]ZoneState

    daemonSetStore          appsv1listers.DaemonSetLister
    daemonSetInformerSynced cache.InformerSynced
    leaseLister         coordlisters.LeaseLister
    leaseInformerSynced cache.InformerSynced
    nodeLister          corelisters.NodeLister
    nodeInformerSynced  cache.InformerSynced

    getPodsAssignedToNode func(nodeName string) ([]v1.Pod, error)

    recorder record.EventRecorder

    // kube-controller-manager 启动时指定的几个参数
    nodeMonitorPeriod time.Duration
    nodeStartupGracePeriod time.Duration
    nodeMonitorGracePeriod time.Duration
    podEvictionTimeout          time.Duration
    evictionLimiterQPS          float32
    secondaryEvictionLimiterQPS float32
    largeClusterThreshold       int32
    unhealthyZoneThreshold      float32

    // 启动时默认开启的几个 feature-gates
    runTaintManager bool
    useTaintBasedEvictions bool
    taintNodeByCondition bool

    nodeUpdateQueue workqueue.Interface
}
```



`NewNodeLifecycleController` 的主要逻辑为：

- 1、初始化 controller 对象；
- 2、为 podInformer 注册与 `taintManager` 相关的 EventHandler；
- 3、若启用 TaintManager 则为 nodeInformer 注册与 `taintManager` 相关的 EventHandler；
- 4、为 NodeLifecycleController 注册 nodeInformer；
- 5、检查是否启用了 `NodeLease` feature-gates；
- 6、daemonSet 默认不会注册对应的 EventHandler，此处仅仅是同步该对象；

由以上逻辑可以看出，`taintManager` 以及 NodeLifecycleController 都会 watch node 的变化并进行不同的处理。



`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:268`

```
func NewNodeLifecycleController(......) (*Controller, error) {
    ......

    // 1、初始化 controller 对象
    nc := &Controller{
        ......
    }
		
    ......
		
    // 2、注册计算 node 驱逐速率以及 zone 状态的方法
    nc.enterPartialDisruptionFunc = nc.ReducedQPSFunc
    nc.enterFullDisruptionFunc = nc.HealthyQPSFunc
    nc.computeZoneStateFunc = nc.ComputeZoneState

    // 3、为 podInformer 注册 EventHandler，监听到的对象会被放到 nc.taintManager.PodUpdated 中
    podInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc: func(obj interface{}) {
            pod := obj.(*v1.Pod)
            if nc.taintManager != nil {
                nc.taintManager.PodUpdated(nil, pod)
            }
        },
        UpdateFunc: func(prev, obj interface{}) {
            prevPod := prev.(*v1.Pod)
            newPod := obj.(*v1.Pod)
            if nc.taintManager != nil {
                nc.taintManager.PodUpdated(prevPod, newPod)
            }
        },
        DeleteFunc: func(obj interface{}) {
            pod, isPod := obj.(*v1.Pod)
            if !isPod {
                deletedState, ok := obj.(cache.DeletedFinalStateUnknown)
                if !ok {
                    return
                }
                pod, ok = deletedState.Obj.(*v1.Pod)
                if !ok {
                    return
                }
            }
            if nc.taintManager != nil {
                nc.taintManager.PodUpdated(pod, nil)
            }
        },
    })
    nc.podInformerSynced = podInformer.Informer().HasSynced
    podInformer.Informer().AddIndexers(cache.Indexers{
        nodeNameKeyIndex: func(obj interface{}) ([]string, error) {
            pod, ok := obj.(*v1.Pod)
            if !ok {
                return []string{}, nil
            }
            if len(pod.Spec.NodeName) == 0 {
                return []string{}, nil
            }
            return []string{pod.Spec.NodeName}, nil
        },
    })

    podIndexer := podInformer.Informer().GetIndexer()
    nc.getPodsAssignedToNode = func(nodeName string) ([]v1.Pod, error) {
        objs, err := podIndexer.ByIndex(nodeNameKeyIndex, nodeName)
        if err != nil {
            return nil, err
        }
        pods := make([]v1.Pod, 0, len(objs))
        for _, obj := range objs {
            pod, ok := obj.(*v1.Pod)
            if !ok {
                continue
            }
            pods = append(pods, *pod)
        }
        return pods, nil
    }
    
    // 4、初始化 TaintManager，为 nodeInformer 注册 EventHandler
    //    监听到的对象会被放到 nc.taintManager.NodeUpdated 中
    if nc.runTaintManager {
        podLister := podInformer.Lister()
        podGetter := func(name, namespace string) (*v1.Pod, error) { return podLister.Pods(namespace).Get(name) }
        nodeLister := nodeInformer.Lister()
        nodeGetter := func(name string) (*v1.Node, error) { return nodeLister.Get(name) }
        
        // 5、初始化 taintManager
        nc.taintManager = scheduler.NewNoExecuteTaintManager(kubeClient, podGetter, nodeGetter, nc.getPodsAssignedToNode)
        nodeInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
            AddFunc: nodeutil.CreateAddNodeHandler(func(node *v1.Node) error {
                nc.taintManager.NodeUpdated(nil, node)
                return nil
            }),
            UpdateFunc: nodeutil.CreateUpdateNodeHandler(func(oldNode, newNode *v1.Node) error {
                nc.taintManager.NodeUpdated(oldNode, newNode)
                return nil
            }),
            DeleteFunc: nodeutil.CreateDeleteNodeHandler(func(node *v1.Node) error {
                nc.taintManager.NodeUpdated(node, nil)
                return nil
            }),
        })
    }
    
    // 6、为 NodeLifecycleController 注册 nodeInformer 
    nodeInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc: nodeutil.CreateAddNodeHandler(func(node *v1.Node) error {
            nc.nodeUpdateQueue.Add(node.Name)
            return nil
        }),
        UpdateFunc: nodeutil.CreateUpdateNodeHandler(func(_, newNode *v1.Node) error {
            nc.nodeUpdateQueue.Add(newNode.Name)
            return nil
        }),
    })

    ......
		
    // 7、检查是否启用了 NodeLease feature-gates
    nc.leaseLister = leaseInformer.Lister()
    if utilfeature.DefaultFeatureGate.Enabled(features.NodeLease) {
        nc.leaseInformerSynced = leaseInformer.Informer().HasSynced
    } else {
        nc.leaseInformerSynced = func() bool { return true }
    }

    nc.nodeLister = nodeInformer.Lister()
    nc.nodeInformerSynced = nodeInformer.Informer().HasSynced

    nc.daemonSetStore = daemonSetInformer.Lister()
    nc.daemonSetInformerSynced = daemonSetInformer.Informer().HasSynced

    return nc, nil
}
```



#### Run

`Run` 方法是 NodeLifecycleController 的启动方法，其中会启动多个 goroutine 完成 controller 的功能，主要逻辑为：
- 1、等待四种对象 Informer 中的 cache 同步完成；
- 2、若指定要运行 taintManager 则调用 `nc.taintManager.Run` 启动 taintManager；
- 3、启动多个 goroutine 调用 `nc.doNodeProcessingPassWorker` 处理 `nc.nodeUpdateQueue` 队列中的 node；
- 4、若启用了 `TaintBasedEvictions` 特性则启动一个 goroutine 调用 `nc.doNoExecuteTaintingPass` 处理 `nc.zoneNoExecuteTainter` 队列中的 node，否则调用 `nc.doEvictionPass` 处理 `nc.zonePodEvictor` 队列中的 node；  
- 5、启动一个 goroutine 调用 `nc.monitorNodeHealth` 定期监控 node 的状态；



`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:455`

```
func (nc *Controller) Run(stopCh <-chan struct{}) {
    defer utilruntime.HandleCrash()

    defer klog.Infof("Shutting down node controller")

    if !cache.WaitForNamedCacheSync("taint", stopCh, nc.leaseInformerSynced, nc.nodeInformerSynced, nc.podInformerSynced, nc.daemonSetInformerSynced) {         return
    }

    // 1、启动 taintManager
    if nc.runTaintManager {
        go nc.taintManager.Run(stopCh)
    }

    defer nc.nodeUpdateQueue.ShutDown()

    // 2、执行 nc.doNodeProcessingPassWorker
    for i := 0; i < scheduler.UpdateWorkerSize; i++ {
        go wait.Until(nc.doNodeProcessingPassWorker, time.Second, stopCh)
    }

    // 3、根据是否启用 TaintBasedEvictions 执行不同的处理逻辑
    if nc.useTaintBasedEvictions {
        go wait.Until(nc.doNoExecuteTaintingPass, scheduler.NodeEvictionPeriod, stopCh)
    } else {
        go wait.Until(nc.doEvictionPass, scheduler.NodeEvictionPeriod, stopCh)
    }

    // 4、执行 nc.monitorNodeHealth
    go wait.Until(func() {
        if err := nc.monitorNodeHealth(); err != nil {
            klog.Errorf("Error monitoring node health: %v", err)
        }
    }, nc.nodeMonitorPeriod, stopCh)

    <-stopCh
}
```



`Run` 方法中主要调用了 5 个方法来完成其核心功能：
- `nc.taintManager.Run`：处理 `taintManager` 中 nodeUpdateQueue 和  podUpdateQueue 中的 pod 以及 node，若 pod 不能容忍 node 上的 taint 则将其加入到 `taintEvictionQueue` 中并最终会删除；
- `nc.doNodeProcessingPassWorker`：从 NodeLifecycleController 的 nodeUpdateQueue 取出 node，（1）若启用 `taintNodeByCondition` 特性时根据 node condition 以及 node 是否调度为 node 添加对应的 `NoSchedule` taint 标签；（2）调用 `nc.reconcileNodeLabels` 为 node 添加默认的 label；
- `nc.doNoExecuteTaintingPass`：处理 `nc.zoneNoExecuteTainter` 队列中的数据，根据 node 的 NodeReadyCondition 添加或移除对应的 taint；
- `nc.doEvictionPass`：处理 `nc.zonePodEvictor` 队列中的 node，将 node 上的 pod 进行驱逐；
- `nc.monitorNodeHealth`：持续监控 node 的状态，当 node 处于异常状态时更新 node 的 taint 以及 node 上 pod 的状态或者直接驱逐 node 上的 pod，此外还会为集群下的所有 node 划分 zoneStates 并为每个 zoneStates 设置对应的驱逐速率；

  

下文会详细分析以上 5 种方法的具体实现。

#### nc.taintManager.Run

当组件启动时设置 `--enable-taint-manager` 参数为 true 时(默认为 true)，该功能会启用，其主要作用是当该 node 上的 pod 不容忍 node taint 时将 pod 进行驱逐，若不开启该功能则已调度到该 node 上的 pod 会继续存在，新创建的 pod 需要容忍 node 的 taint 才会调度至该 node 上。


主要逻辑为：
- 1、处理 nodeUpdateQueue 中的 node 并将其发送到 nodeUpdateChannels 中；
- 2、处理 podUpdateQueue 中的 pod 并将其发送到 podUpdateChannels 中；
- 3、调用 `tc.worker` 处理 nodeUpdateChannels 和 podUpdateChannels 中的数据；



`k8s.io/kubernetes/pkg/controller/nodelifecycle/scheduler/taint_manager.go:185`

```
func (tc *NoExecuteTaintManager) Run(stopCh <-chan struct{}) {
    for i := 0; i < UpdateWorkerSize; i++ {
        tc.nodeUpdateChannels = append(tc.nodeUpdateChannels, make(chan nodeUpdateItem, NodeUpdateChannelSize))
        tc.podUpdateChannels = append(tc.podUpdateChannels, make(chan podUpdateItem, podUpdateChannelSize))
    }

    go func(stopCh <-chan struct{}) {
        for {
            item, shutdown := tc.nodeUpdateQueue.Get()
            if shutdown {
                break
            }
            nodeUpdate := item.(nodeUpdateItem)
            hash := hash(nodeUpdate.nodeName, UpdateWorkerSize)
            select {
            case <-stopCh:
                tc.nodeUpdateQueue.Done(item)
                return
            case tc.nodeUpdateChannels[hash] <- nodeUpdate:
            }
        }
    }(stopCh)
    
    go func(stopCh <-chan struct{}) {
        for {
            item, shutdown := tc.podUpdateQueue.Get()
            if shutdown {
                break
            }
            podUpdate := item.(podUpdateItem)
            hash := hash(podUpdate.nodeName, UpdateWorkerSize)
            select {
            case <-stopCh:
                tc.podUpdateQueue.Done(item)
                return
            case tc.podUpdateChannels[hash] <- podUpdate:
            }
        }
    }(stopCh)

    wg := sync.WaitGroup{}
    wg.Add(UpdateWorkerSize)
    for i := 0; i < UpdateWorkerSize; i++ {
        go tc.worker(i, wg.Done, stopCh)
    }
    wg.Wait()
}
```



##### tc.worker

`tc.worker` 主要功能是调用 `tc.handleNodeUpdate` 和 `tc.handlePodUpdate` 处理 `tc.nodeUpdateChannels` 和 `tc.podUpdateChannels` 两个 channel 中的数据，但会优先处理 nodeUpdateChannels 中的数据。


`k8s.io/kubernetes/pkg/controller/nodelifecycle/scheduler/taint_manager.go:243`

```
func (tc *NoExecuteTaintManager) worker(worker int, done func(), stopCh <-chan struct{}) {
    defer done()

    for {
        select {
        case <-stopCh:
            return
        case nodeUpdate := <-tc.nodeUpdateChannels[worker]:
            tc.handleNodeUpdate(nodeUpdate)
            tc.nodeUpdateQueue.Done(nodeUpdate)
        case podUpdate := <-tc.podUpdateChannels[worker]:

        // 优先处理 nodeUpdateChannels 
        priority:
            for {
                select {
                case nodeUpdate := <-tc.nodeUpdateChannels[worker]:
                    tc.handleNodeUpdate(nodeUpdate)
                    tc.nodeUpdateQueue.Done(nodeUpdate)
                default:
                    break priority
                }
            }
            tc.handlePodUpdate(podUpdate)
            tc.podUpdateQueue.Done(podUpdate)
        }
    }
}
```



###### tc.handleNodeUpdate

`tc.handleNodeUpdate` 的主要逻辑为：
- 1、首先通过 nodeLister 获取 node 对象；
- 2、获取 node 上 effect 为 `NoExecute` 的 taints；
- 3、调用 `tc.getPodsAssignedToNode` 获取该 node 上的所有 pods；
- 4、若 node 上的 taints 为空直接返回，否则遍历每一个 pod 调用 `tc.processPodOnNode` 检查 pod 是否要被驱逐；


`k8s.io/kubernetes/pkg/controller/nodelifecycle/scheduler/taint_manager.go:417`

```
func (tc *NoExecuteTaintManager) handleNodeUpdate(nodeUpdate nodeUpdateItem) {
    node, err := tc.getNode(nodeUpdate.nodeName)
    if err != nil {
        ......
    }
    // 1、获取 node 的 taints
    taints := getNoExecuteTaints(node.Spec.Taints)
    func() {
        tc.taintedNodesLock.Lock()
        defer tc.taintedNodesLock.Unlock()
        if len(taints) == 0 {
            delete(tc.taintedNodes, node.Name)
        } else {
            tc.taintedNodes[node.Name] = taints
        }
    }()
    
    // 2、获取 node 上的所有 pod
    pods, err := tc.getPodsAssignedToNode(node.Name)
    if err != nil {
        klog.Errorf(err.Error())
        return
    }
    if len(pods) == 0 {
        return
    }

    // 3、若不存在 taints，则取消所有的驱逐操作
    if len(taints) == 0 {
        for i := range pods {
            tc.cancelWorkWithEvent(types.NamespacedName{Namespace: pods[i].Namespace, Name: pods[i].Name})
        }
        return
    }

    now := time.Now()
    for i := range pods {
        pod := &pods[i]
        podNamespacedName := types.NamespacedName{Namespace: pod.Namespace, Name: pod.Name}
        // 4、调用 tc.processPodOnNode 进行处理
        tc.processPodOnNode(podNamespacedName, node.Name, pod.Spec.Tolerations, taints, now)
    }
}
```



###### tc.handlePodUpdate 

主要逻辑为：
- 1、通过 podLister 获取 pod 对象；
- 2、获取 pod 所在 node 的 taints；
- 3、调用 `tc.processPodOnNode` 进行处理；


`k8s.io/kubernetes/pkg/controller/nodelifecycle/scheduler/taint_manager.go:377`

```
func (tc *NoExecuteTaintManager) handlePodUpdate(podUpdate podUpdateItem) {
    pod, err := tc.getPod(podUpdate.podName, podUpdate.podNamespace)
    if err != nil {
        ......
    }

    if pod.Spec.NodeName != podUpdate.nodeName {
        return
    }

    podNamespacedName := types.NamespacedName{Namespace: pod.Namespace, Name: pod.Name}

    nodeName := pod.Spec.NodeName
    if nodeName == "" {
        return
    }
    taints, ok := func() ([]v1.Taint, bool) {
        tc.taintedNodesLock.Lock()
        defer tc.taintedNodesLock.Unlock()
        taints, ok := tc.taintedNodes[nodeName]
        return taints, ok
    }()

    if !ok {
        return
    }
    // 调用 tc.processPodOnNode 进行处理
    tc.processPodOnNode(podNamespacedName, nodeName, pod.Spec.Tolerations, taints, time.Now())
}
```



###### tc.processPodOnNode

`tc.handlePodUpdate` 和 `tc.handleNodeUpdate` 最终都是调用 `tc.processPodOnNode` 检查 pod 是否容忍 node 的 taints，`tc.processPodOnNode` 首先检查 pod 的 tolerations 是否能匹配 node 上所有的 taints，若无法完全匹配则将 pod 加入到 taintEvictionQueue 然后被删除，若能匹配首先获取 pod tolerations 中的最小容忍时间，如果 tolerations 未设置容忍时间说明会一直容忍则直接返回，否则加入到 taintEvictionQueue 的延迟队列中，当达到最小容忍时间时 pod 会被加入到 taintEvictionQueue 中并驱逐。


通常情况下，如果给一个节点添加了一个 effect 值为 `NoExecute` 的 taint，则任何不能忍受这个 taint 的 pod 都会马上被驱逐，任何可以忍受这个 taint 的 pod 都不会被驱逐。但是，如果 pod 存在一个 effect 值为 `NoExecute` 的 toleration 指定了可选属性 `tolerationSeconds` 的值，则表示在给节点添加了上述 taint 之后，pod 还能继续在节点上运行的时间。例如，

```
tolerations:
- key: "key1"
  operator: "Equal"
  value: "value1"
  effect: "NoExecute"
  tolerationSeconds: 3600
```

这表示如果这个 pod 正在运行，然后一个匹配的 taint 被添加到其所在的节点，那么 pod 还将继续在节点上运行 3600 秒，然后被驱逐。如果在此之前上述 taint 被删除了，则 pod 不会被驱逐。



`k8s.io/kubernetes/pkg/controller/nodelifecycle/scheduler/taint_manager.go:339`

```
func (tc *NoExecuteTaintManager) processPodOnNode(......) {
    if len(taints) == 0 {
        tc.cancelWorkWithEvent(podNamespacedName)
    }
    // 1、检查 pod 的 tolerations 是否匹配所有 taints
    allTolerated, usedTolerations := v1helper.GetMatchingTolerations(taints, tolerations)
    if !allTolerated {
        tc.cancelWorkWithEvent(podNamespacedName)
        tc.taintEvictionQueue.AddWork(NewWorkArgs(podNamespacedName.Name, podNamespacedName.Namespace), time.Now(), time.Now())
        return
    }
    
    // 2、获取最小容忍时间
    minTolerationTime := getMinTolerationTime(usedTolerations)
    if minTolerationTime < 0 {
        return
    }
    
    // 3、若存在最小容忍时间则将其加入到延时队列中
    startTime := now
    triggerTime := startTime.Add(minTolerationTime)
    scheduledEviction := tc.taintEvictionQueue.GetWorkerUnsafe(podNamespacedName.String())
    if scheduledEviction != nil {
        startTime = scheduledEviction.CreatedAt
        if startTime.Add(minTolerationTime).Before(triggerTime) {
            return
        }
        tc.cancelWorkWithEvent(podNamespacedName)
    }
    tc.taintEvictionQueue.AddWork(NewWorkArgs(podNamespacedName.Name, podNamespacedName.Namespace), startTime, triggerTime)
}
```



#### nc.doNodeProcessingPassWorker

NodeLifecycleController 中 nodeInformer 监听到 node 变化时会将其添加到 nodeUpdateQueue 中，`nc.doNodeProcessingPassWorker` 主要是处理 nodeUpdateQueue 中的 node，为其添加合适的 `NoSchedule` taint 以及 label，其主要逻辑为：
- 1、从 `nc.nodeUpdateQueue` 中取出 node；
- 2、若启用了 `TaintNodeByCondition` feature-gates，调用` nc.doNoScheduleTaintingPass` 检查该 node 是否需要添加对应的 `NoSchedule` taint；
  `nc.doNoScheduleTaintingPass` 中的主要逻辑为：
  - 1、从 nodeLister 中获取该 node 对象；
  - 2、判断该 node 是否存在以下几种 Condition：(1) False 或 Unknown 状态的 NodeReady Condition；(2) MemoryPressureCondition；(3) DiskPressureCondition；(4) NetworkUnavailableCondition；(5) PIDPressureCondition；若任一一种存在会添加对应的 `NoSchedule` taint；
  - 3、判断 node 是否处于 `Unschedulable` 状态，若为 `Unschedulable` 也添加对应的 `NoSchedule` taint；
  - 4、对比 node 已有的 taints 以及需要添加的 taints，以需要添加的 taints 为准，调用 `nodeutil.SwapNodeControllerTaint` 为 node 添加不存在的 taints 并删除不需要的 taints；
- 3、调用 `nc.reconcileNodeLabels` 检查 node 是否存在以下 label，若不存在则为其添加；

  ```
    labels:
      beta.kubernetes.io/arch: amd64
      beta.kubernetes.io/os: linux
      kubernetes.io/arch: amd64
      kubernetes.io/os: linux
  ```




`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:502`

```
func (nc *Controller) doNodeProcessingPassWorker() {
    for {
        obj, shutdown := nc.nodeUpdateQueue.Get()
        if shutdown {
            return
        }
        nodeName := obj.(string)
        if nc.taintNodeByCondition {
            if err := nc.doNoScheduleTaintingPass(nodeName); err != nil {
                ......
            }
        }

        if err := nc.reconcileNodeLabels(nodeName); err != nil {
            ......
        }
        nc.nodeUpdateQueue.Done(nodeName)
    }
}

func (nc *Controller) doNoScheduleTaintingPass(nodeName string) error {
    // 1、获取 node 对象
    node, err := nc.nodeLister.Get(nodeName)
    if err != nil {
        ......
    }
		
    // 2、若 node 存在对应的 condition 则为其添加对应的 taint
    var taints []v1.Taint
    for _, condition := range node.Status.Conditions {
        if taintMap, found := nodeConditionToTaintKeyStatusMap[condition.Type]; found {
            if taintKey, found := taintMap[condition.Status]; found {
                taints = append(taints, v1.Taint{
                    Key:    taintKey,
                    Effect: v1.TaintEffectNoSchedule,
                })
            }
        }
    }
    
    // 3、判断是否为 Unschedulable 
    if node.Spec.Unschedulable {
        taints = append(taints, v1.Taint{
            Key:    schedulerapi.TaintNodeUnschedulable,
            Effect: v1.TaintEffectNoSchedule,
        })
    }

    nodeTaints := taintutils.TaintSetFilter(node.Spec.Taints, func(t *v1.Taint) bool {
        if t.Effect != v1.TaintEffectNoSchedule {
            return false
        }
        if t.Key == schedulerapi.TaintNodeUnschedulable {
            return true
        }
        _, found := taintKeyToNodeConditionMap[t.Key]
        return found
    })
    
    // 4、对比 node 已有 taints 和需要添加的 taints 得到 taintsToAdd, taintsToDel
    taintsToAdd, taintsToDel := taintutils.TaintSetDiff(taints, nodeTaints)
    if len(taintsToAdd) == 0 && len(taintsToDel) == 0 {
        return nil
    }
    
    // 5、更新 node 的 taints
    if !nodeutil.SwapNodeControllerTaint(nc.kubeClient, taintsToAdd, taintsToDel, node) {
        return fmt.Errorf("failed to swap taints of node %+v", node)
    }
    return nil
}
```



#### nc.doNoExecuteTaintingPass

当启用了 `TaintBasedEvictions` 特性时，通过 `nc.monitorNodeHealth` 检测到 node 异常时会将其加入到 `nc.zoneNoExecuteTainter` 队列中，`nc.doNoExecuteTaintingPass` 会处理 `nc.zoneNoExecuteTainter` 队列中的 node，并且会按一定的速率进行，此时会根据 node 实际的 NodeCondition 为 node 添加对应的 taint，当 node 存在 taint 时，taintManager 会驱逐 node 上的 pod。此过程中为 node 添加 taint 时进行了限速避免一次性驱逐过多 pod，在驱逐 node 上的 pod 时不会限速。


`nc.doNoExecuteTaintingPass` 的主要逻辑为：
- 1、遍历 zoneNoExecuteTainter 中的 node 列表，从 nodeLister 中获取 node 对象；
- 2、获取该 node 的 NodeReadyCondition；
- 3、判断 NodeReadyCondition 的状态，若为 false，则为 node 添加 `node.kubernetes.io/not-ready:NoExecute` 的 taint 且保证 node 不存在 `node.kubernetes.io/unreachable:NoExecute` 的 taint;
- 4、若 NodeReadyCondition 为 unknown，则为 node 添加 `node.kubernetes.io/unreachable:NoExecute` 的 taint 且保证 node 不存在 `node.kubernetes.io/not-ready:NoExecute` 的 taint；
  "unreachable" 和 "not ready" 两个 taint 是互斥的，只能存在一个； 
- 5、若 NodeReadyCondition 为 true，此时说明该 node 处于正常状态直接返回；
- 6、调用 `nodeutil.SwapNodeControllerTaint` 更新 node 的 taint；
- 7、若整个过程中有失败的操作会进行重试；


`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:582`

```
func (nc *Controller) doNoExecuteTaintingPass() {
    nc.evictorLock.Lock()
    defer nc.evictorLock.Unlock()
    for k := range nc.zoneNoExecuteTainter {
        nc.zoneNoExecuteTainter[k].Try(func(value scheduler.TimedValue) (bool, time.Duration) {
            // 1、获取 node 对象
            node, err := nc.nodeLister.Get(value.Value)
            if apierrors.IsNotFound(err) {
                return true, 0
            } else if err != nil {
                return false, 50 * time.Millisecond
            }
            
            // 2、获取 node 的 NodeReadyCondition
            _, condition := nodeutil.GetNodeCondition(&node.Status, v1.NodeReady)
            taintToAdd := v1.Taint{}
            oppositeTaint := v1.Taint{}
            
            // 3、判断 Condition 状态，并为其添加对应的 taint
            switch condition.Status {
            case v1.ConditionFalse:
                taintToAdd = *NotReadyTaintTemplate
                oppositeTaint = *UnreachableTaintTemplate
            case v1.ConditionUnknown:
                taintToAdd = *UnreachableTaintTemplate
                oppositeTaint = *NotReadyTaintTemplate
            default:
                return true, 0
            }
            
            // 4、更新 node 的 taint
            result := nodeutil.SwapNodeControllerTaint(nc.kubeClient, []*v1.Taint{&taintToAdd}, []*v1.Taint{&oppositeTaint}, node)
            if result {
                zone := utilnode.GetZoneKey(node)
                evictionsNumber.WithLabelValues(zone).Inc()
            }

            return result, 0
        })
    }
}
```



#### nc.doEvictionPass

若未启用 `TaintBasedEvictions` 特性，此时通过 `nc.monitorNodeHealth` 检测到 node 异常时会将其加入到  `nc.zonePodEvictor` 队列中，`nc.doEvictionPass` 会将 `nc.zonePodEvictor` 队列中 node 上的 pod 驱逐掉。

`nc.doEvictionPass` 的主要逻辑为：
- 1、遍历 zonePodEvictor 的 node 列表，从 nodeLister 中获取 node 对象；
- 2、调用 `nodeutil.DeletePods` 删除该 node 上的所有 pod，在 `nodeutil.DeletePods` 中首先通过从 apiserver  获取该 node 上所有的 pod，逐个删除 pod，若该 pod 为 daemonset 所管理的 pod 则忽略；
- 3、若整个过程中有失败的操作会进行重试；



`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:626`

```
func (nc *Controller) doEvictionPass() {
    nc.evictorLock.Lock()
    defer nc.evictorLock.Unlock()
    for k := range nc.zonePodEvictor {
        nc.zonePodEvictor[k].Try(func(value scheduler.TimedValue) (bool, time.Duration) {
            node, err := nc.nodeLister.Get(value.Value)
            ......
            nodeUID, _ := value.UID.(string)
            remaining, err := nodeutil.DeletePods(nc.kubeClient, nc.recorder, value.Value, nodeUID, nc.daemonSetStore)
            if err != nil {
                utilruntime.HandleError(fmt.Errorf("unable to evict node %q: %v", value.Value, err))
                return false, 0
            }
            ......

            if node != nil {
                zone := utilnode.GetZoneKey(node)
                evictionsNumber.WithLabelValues(zone).Inc()
            }

            return true, 0
        })
    }
}
```



#### nc.monitorNodeHealth

上面已经介绍了无论是否启用了 `TaintBasedEvictions` 特性，需要打 taint 或者驱逐 pod 的 node 都会被放在 zoneNoExecuteTainter 或者 zonePodEvictor 队列中，而 `nc.monitorNodeHealth` 就是这两个队列中数据的生产者。`nc.monitorNodeHealth` 的主要功能是持续监控 node 的状态，当 node 处于异常状态时更新 node 的 taint 以及 node 上 pod 的状态或者直接驱逐 node 上的 pod，此外还会为集群下的所有 node 划分 zoneStates 并为每个 zoneStates 设置对应的驱逐速率。



`nc.monitorNodeHealth` 主要逻辑为：
- 1、从 nodeLister 中获取所有的 node；
- 2、NodeLifecycleController 根据自身 knownNodeSet 列表中的数据调用 `nc.classifyNodes` 将 node 分为三类：added、deleted、newZoneRepresentatives，added 表示新增的，deleted 表示被删除的，newZoneRepresentatives 代表该 node 不存在 zoneStates，NodeLifecycleController 会为每一个 node 划分一个 zoneStates，zoneStates 有 Initial、Normal、FullDisruption、PartialDisruption 四种，新增加的 node 默认的 zoneStates 为 Initial，其余的几个 zoneStates 分别对应着不同的驱逐速率；
- 3、对于 newZoneRepresentatives 中 node 列表，调用 `nc.addPodEvictorForNewZone` 将 node 添加到对应的的 zoneStates 中，然后根据是否启用了 `TaintBasedEvictions` 特性将 node 分别加入到 zonePodEvictor 或 zoneNoExecuteTainter 列表中，若启用了则加入到 zoneNoExecuteTainter 列表中否则加入到 zonePodEvictor 中；
- 4、对应 added 列表中的 node，首先将其加入到 knownNodeSet 列表中，然后调用 `nc.addPodEvictorForNewZone` 将该 node 添加到对应的 zoneStates 中，判断是否启用了 `TaintBasedEvictions` 特性，若启用了则调用 `nc.markNodeAsReachable` 移除该 node 上的 `UnreachableTaint` 和 `NotReadyTaint`，并从 zoneNoExecuteTainter 中移除该 node，表示为该 node 进行一次初始化，若未启用 `TaintBasedEvictions` 特性则调用 `nc.cancelPodEviction` 将该 node 从 zonePodEvictor 中删除；
- 5、对于 deleted 列表中的 node，将其从 knownNodeSet 列表中删除；
- 6、遍历所有的 nodes：
- 7、调用 `nc.tryUpdateNodeHealth` 获取该 node 的 gracePeriod、observedReadyCondition、currentReadyCondition，observedReadyCondition 可以理解为 node 上一次的状态， currentReadyCondition 为本次的状态；
- 8、检查 node 是否在中断检查中被排除，主要判断当启用 `LegacyNodeRoleBehavior` 或 `NodeDisruptionExclusion` 特性时，node 是否存在对应的标签，如果该 node 没有被排除，则将其对应的 zone 加入到 zoneToNodeConditions 中；
- 9、当该 node 的 currentReadyCondition 不为空时，检查 observedReadyCondition，即检查上一次的状态：
  - 1、若 observedReadyCondition 为 false，此时若启用了 `TaintBasedEvictions` 时，为其添加 `NotReadyTaint` 并且确保 node 不存在 `UnreachableTaint` 。若未启用 `TaintBasedEvictions` 则判断距 node 上一次 readyTransitionTimestamp 的时间是否超过了 `podEvictionTimeout`（默认 5 分钟），若超过则将 node 加入到 zonePodEvictor 队列中，最终会驱逐 node 上的所有 pod；
  - 2、若 observedReadyCondition 为 unknown，此时若启用了 `TaintBasedEvictions` 时，则为 node 添加 `UnreachableTaint` 并且确保 node 不会有 `NotReadyTaint`。若未启用 `TaintBasedEvictions` 则判断距 node 上一次 probeTimestamp 的时间是否超过了 `podEvictionTimeout`（默认 5 分钟），若超过则将 node 加入到 zonePodEvictor 队列中，最终会驱逐 node 上的所有 pod；
  - 3、若 observedReadyCondition 为 true 时，此时若启用了 `TaintBasedEvictions` 时，调用 `nc.markNodeAsReachable` 移除 node 上的 `NotReadyTaint` 和 `UnreachableTaint` ，若未启用 `TaintBasedEvictions` 则将 node 从 zonePodEvictor 队列中移除；
    此处主要是判断是否启用了 `TaintBasedEvictions`  特性，然后根据 node 的 ReadyCondition 判断是否直接驱逐 node 上的 pod 还是为 node 打 taint 等待 taintManager 驱逐 node 上的 pod； 
- 10、最后判断当 node ReadyCondition 由 true 变为 false 时，调用 `nodeutil.MarkAllPodsNotReady` 将该node 上的所有 pod 标记为 notReady；
- 11、调用 `nc.handleDisruption` 处理中断情况，为不同 zoneState 设置驱逐的速度；


`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:664`

```
func (nc *Controller) monitorNodeHealth() error {
    // 1、从 nodeLister 获取所有 node
    nodes, err := nc.nodeLister.List(labels.Everything())
    if err != nil {
        return err
    }
    
    // 2、根据 controller knownNodeSet 中的记录将 node 分为三类
    added, deleted, newZoneRepresentatives := nc.classifyNodes(nodes)
	
    // 3、为没有 zone 的 node 添加对应的 zone
    for i := range newZoneRepresentatives {
        nc.addPodEvictorForNewZone(newZoneRepresentatives[i])
    }

    // 4、将新增加的 node 添加到 knownNodeSet 中并且对 node 进行初始化
    for i := range added {
        ......
        nc.knownNodeSet[added[i].Name] = added[i]
        nc.addPodEvictorForNewZone(added[i])
        if nc.useTaintBasedEvictions {
            nc.markNodeAsReachable(added[i])
        } else {
            nc.cancelPodEviction(added[i])
        }
    }
    
    // 5、将 deleted 列表中的 node 从 knownNodeSet 中删除
    for i := range deleted {
        ......
        delete(nc.knownNodeSet, deleted[i].Name)
    }

    zoneToNodeConditions := map[string][]*v1.NodeCondition{}
    for i := range nodes {
        var gracePeriod time.Duration
        var observedReadyCondition v1.NodeCondition
        var currentReadyCondition *v1.NodeCondition
        node := nodes[i].DeepCopy()
        
        // 6、获取 node 的 gracePeriod, observedReadyCondition, currentReadyCondition
        if err := wait.PollImmediate(retrySleepTime, retrySleepTime*scheduler.NodeHealthUpdateRetry, func() (bool, error) {
            gracePeriod, observedReadyCondition, currentReadyCondition, err = nc.tryUpdateNodeHealth(node)
            if err == nil {
                return true, nil
            }
            name := node.Name
            node, err = nc.kubeClient.CoreV1().Nodes().Get(name, metav1.GetOptions{})
            if err != nil {
                return false, err
            }
            return false, nil
        }); err != nil {
            ......
        }
        
        // 7、若 node 没有被排除则加入到 zoneToNodeConditions 列表中
        if !isNodeExcludedFromDisruptionChecks(node) {
            zoneToNodeConditions[utilnode.GetZoneKey(node)] = append(zoneToNodeConditions[utilnode.GetZoneKey(node)], currentReadyCondition)
        }

        decisionTimestamp := nc.now()
        
        // 8、根据 observedReadyCondition 为 node 添加不同的 taint 
        if currentReadyCondition != nil {
            switch observedReadyCondition.Status {
            
            case v1.ConditionFalse:
                // 9、false 状态添加 NotReady taint
                if nc.useTaintBasedEvictions {
                    if taintutils.TaintExists(node.Spec.Taints, UnreachableTaintTemplate) {
                        taintToAdd := *NotReadyTaintTemplate
                        if !nodeutil.SwapNodeControllerTaint(nc.kubeClient, []*v1.Taint{&taintToAdd}, []*v1.Taint{UnreachableTaintTemplate}, node) {
                            ......
                        }
                    } else if nc.markNodeForTainting(node) {
                        ......
                    }
                // 10、或者当超过 podEvictionTimeout 后直接驱逐 node 上的 pod
                } else {
                    if decisionTimestamp.After(nc.nodeHealthMap[node.Name].readyTransitionTimestamp.Add(nc.podEvictionTimeout)) {
                        if nc.evictPods(node) {
                            ......
                        }
                    }
                }
            case v1.ConditionUnknown:
                // 11、unknown 状态时添加 UnreachableTaint
                if nc.useTaintBasedEvictions {
                    if taintutils.TaintExists(node.Spec.Taints, NotReadyTaintTemplate) {
                        taintToAdd := *UnreachableTaintTemplate
                        if !nodeutil.SwapNodeControllerTaint(nc.kubeClient, []*v1.Taint{&taintToAdd}, []*v1.Taint{NotReadyTaintTemplate}, node) {
                            ......
                        }
                    } else if nc.markNodeForTainting(node) {
                        ......
                    }
                } else {
                    if decisionTimestamp.After(nc.nodeHealthMap[node.Name].probeTimestamp.Add(nc.podEvictionTimeout)) {
                        if nc.evictPods(node) {
                            ......
                        }
                    }
                }
            case v1.ConditionTrue:
                // 12、true 状态时移除所有 UnreachableTaint 和 NotReadyTaint
                if nc.useTaintBasedEvictions {
                    removed, err := nc.markNodeAsReachable(node)
                    if err != nil {
                        ......
                    }
                // 13、从 PodEviction 队列中移除
                } else {
                    if nc.cancelPodEviction(node) {
                        ......
                    }
                }
            }

            // 14、ReadyCondition 由 true 变为 false 时标记 node 上的 pod 为 notready
            if currentReadyCondition.Status != v1.ConditionTrue && observedReadyCondition.Status == v1.ConditionTrue {
                nodeutil.RecordNodeStatusChange(nc.recorder, node, "NodeNotReady")
                if err = nodeutil.MarkAllPodsNotReady(nc.kubeClient, node); err != nil {
                    utilruntime.HandleError(fmt.Errorf("Unable to mark all pods NotReady on node %v: %v", node.Name, err))
                }
            }
        }
    }
    // 15、处理中断情况
    nc.handleDisruption(zoneToNodeConditions, nodes)

    return nil
}
```



##### nc.tryUpdateNodeHealth

`nc.tryUpdateNodeHealth` 会根据当前获取的 node status 更新 `nc.nodeHealthMap` 中的数据，`nc.nodeHealthMap` 保存 node 最近一次的状态，并会根据 `nc.nodeHealthMap` 判断 node 是否已经处于 unknown 状态。

`nc.tryUpdateNodeHealth` 的主要逻辑为：
- 1、获取当前 node 的 ReadyCondition 作为 currentReadyCondition，若 ReadyCondition 为空则此 node 可能未上报 status，此时为该 node fake 一个 observedReadyCondition 且其 status 为 Unknown，将其 gracePeriod 设为 nodeStartupGracePeriod，否则 observedReadyCondition 设为 currentReadyCondition 且 gracePeriod 为 nodeMonitorGracePeriod，然后在 `nc.nodeHealthMap` 中更新 node 的 Status；
- 2、若 ReadyCondition 存在，则将 observedReadyCondition 置为当前 ReadyCondition，gracePeriod 设为 40s；
- 3、计算 node 当前的 nodeHealthData，nodeHealthData 中保存了 node 最近一次的状态，包含 probeTimestamp、readyTransitionTimestamp、status、lease 四个字段。从  `nc.nodeHealthMap` 中获取 node 的 condition 和 lease 信息，更新 savedNodeHealth 中 status、probeTimestamp、readyTransitionTimestamp，若启用了 `NodeLease` 特性也会更新 NodeHealth 中的 lease 以及 probeTimestamp，最后将当前计算出 savedNodeHealth 保存到 `nc.nodeHealthMap` 中；
- 4、通过获取到的 savedNodeHealth 检查 node 状态，若 NodeReady condition 或者 lease 对象更新时间超过 gracePeriod，则更新 node 的 Ready、MemoryPressure、DiskPressure、PIDPressure 为 Unknown，若当前计算出来的 node status 与上一次的 status 不一致则同步到 apiserver，并且更新 nodeHealthMap； 
- 5、最后返回 gracePeriod、observedReadyCondition、currentReadyCondition；



`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:851`

```
func (nc *Controller) tryUpdateNodeHealth(node *v1.Node) (time.Duration, v1.NodeCondition, *v1.NodeCondition, error) {
    var gracePeriod time.Duration
    var observedReadyCondition v1.NodeCondition
    _, currentReadyCondition := nodeutil.GetNodeCondition(&node.Status, v1.NodeReady)
    
    // 1、若 currentReadyCondition 为 nil 则 fake 一个 observedReadyCondition
    if currentReadyCondition == nil {
        observedReadyCondition = v1.NodeCondition{
            Type:               v1.NodeReady,
            Status:             v1.ConditionUnknown,
            LastHeartbeatTime:  node.CreationTimestamp,
            LastTransitionTime: node.CreationTimestamp,
        }
        gracePeriod = nc.nodeStartupGracePeriod
        if _, found := nc.nodeHealthMap[node.Name]; found {
            nc.nodeHealthMap[node.Name].status = &node.Status
        } else {
            nc.nodeHealthMap[node.Name] = &nodeHealthData{
                status:                   &node.Status,
                probeTimestamp:           node.CreationTimestamp,
                readyTransitionTimestamp: node.CreationTimestamp,
            }
        }
    } else {
        observedReadyCondition = *currentReadyCondition
        gracePeriod = nc.nodeMonitorGracePeriod
    }
    
    // 2、savedNodeHealth 中保存 node 最近的一次状态
    savedNodeHealth, found := nc.nodeHealthMap[node.Name]

    var savedCondition *v1.NodeCondition
    var savedLease *coordv1beta1.Lease
    if found {
        _, savedCondition = nodeutil.GetNodeCondition(savedNodeHealth.status, v1.NodeReady)
        savedLease = savedNodeHealth.lease
    }
    
    // 3、根据 savedCondition 以及 currentReadyCondition 更新 savedNodeHealth 中的数据
    if !found {
        savedNodeHealth = &nodeHealthData{
            status:                   &node.Status,
            probeTimestamp:           nc.now(),
            readyTransitionTimestamp: nc.now(),
        }
    } else if savedCondition == nil && currentReadyCondition != nil {
        savedNodeHealth = &nodeHealthData{
            status:                   &node.Status,
            probeTimestamp:           nc.now(),
            readyTransitionTimestamp: nc.now(),
        }
    } else if savedCondition != nil && currentReadyCondition == nil {
        savedNodeHealth = &nodeHealthData{
            status:                   &node.Status,
            probeTimestamp:           nc.now(),
            readyTransitionTimestamp: nc.now(),
        }
    } else if savedCondition != nil && currentReadyCondition != nil && savedCondition.LastHeartbeatTime != currentReadyCondition.LastHeartbeatTime {
        var transitionTime metav1.Time
        if savedCondition.LastTransitionTime != currentReadyCondition.LastTransitionTime {
            transitionTime = nc.now()
        } else {
            transitionTime = savedNodeHealth.readyTransitionTimestamp
        }
        
        savedNodeHealth = &nodeHealthData{
            status:                   &node.Status,
            probeTimestamp:           nc.now(),
            readyTransitionTimestamp: transitionTime,
        }
    }
    
    // 4、判断是否启用了 nodeLease 功能
    var observedLease *coordv1beta1.Lease
    if utilfeature.DefaultFeatureGate.Enabled(features.NodeLease) {
        observedLease, _ = nc.leaseLister.Leases(v1.NamespaceNodeLease).Get(node.Name)
        if observedLease != nil && (savedLease == nil || savedLease.Spec.RenewTime.Before(observedLease.Spec.RenewTime)) {
            savedNodeHealth.lease = observedLease
            savedNodeHealth.probeTimestamp = nc.now()
        }
    }
    nc.nodeHealthMap[node.Name] = savedNodeHealth

    // 5、检查 node 是否已经超过 gracePeriod 时间没有上报状态了
    if nc.now().After(savedNodeHealth.probeTimestamp.Add(gracePeriod)) {
        nodeConditionTypes := []v1.NodeConditionType{
            v1.NodeReady,
            v1.NodeMemoryPressure,
            v1.NodeDiskPressure,
            v1.NodePIDPressure,
        }
        nowTimestamp := nc.now()
        
        // 6、若 node 超过 gracePeriod 时间没有上报状态将其所有 Condition 设置 unknown
        for _, nodeConditionType := range nodeConditionTypes {
            _, currentCondition := nodeutil.GetNodeCondition(&node.Status, nodeConditionType)
            if currentCondition == nil {
                node.Status.Conditions = append(node.Status.Conditions, v1.NodeCondition{
                    Type:               nodeConditionType,
                    Status:             v1.ConditionUnknown,
                    Reason:             "NodeStatusNeverUpdated",
                    Message:            "Kubelet never posted node status.",
                    LastHeartbeatTime:  node.CreationTimestamp,
                    LastTransitionTime: nowTimestamp,
                })
            } else {
                if currentCondition.Status != v1.ConditionUnknown {
                    currentCondition.Status = v1.ConditionUnknown
                    currentCondition.Reason = "NodeStatusUnknown"
                    currentCondition.Message = "Kubelet stopped posting node status."
                    currentCondition.LastTransitionTime = nowTimestamp
                }
            }
        }

        // 7、更新 node 最新状态至 apiserver 并更新 nodeHealthMap 中的数据
        _, currentReadyCondition = nodeutil.GetNodeCondition(&node.Status, v1.NodeReady)
        if !apiequality.Semantic.DeepEqual(currentReadyCondition, &observedReadyCondition) {
            if _, err := nc.kubeClient.CoreV1().Nodes().UpdateStatus(node); err != nil {
                return gracePeriod, observedReadyCondition, currentReadyCondition, err
            }
            nc.nodeHealthMap[node.Name] = &nodeHealthData{
                status:                   &node.Status,
                probeTimestamp:           nc.nodeHealthMap[node.Name].probeTimestamp,
                readyTransitionTimestamp: nc.now(),
                lease:                    observedLease,
            }
            return gracePeriod, observedReadyCondition, currentReadyCondition, nil
        }
    }

    return gracePeriod, observedReadyCondition, currentReadyCondition, nil
}
```



##### nc.handleDisruption

`monitorNodeHealth` 中会为每个 node 划分 zone 并设置 zoneState，`nc.handleDisruption` 的目的是当集群中不同 zone 下出现多个 unhealthy node 时会 zone 设置不同的驱逐速率。


`nc.handleDisruption` 主要逻辑为：
- 1、设置 allAreFullyDisrupted 默认值为 true，根据 zoneToNodeConditions 中的数据，判断当前所有 zone 是否都为 FullDisruption 状态；
- 2、遍历 zoneToNodeConditions 首先调用 `nc.computeZoneStateFunc` 计算每个 zone 的状态，分为三种 `fullyDisrupted`（zone 下所有 node 都处于 notReady 状态）、`partiallyDisrupted`（notReady node 占比 >= unhealthyZoneThreshold 的值且 node 数超过三个）、`normal`（以上两种情况之外）。若 newState 不为 `stateFullDisruption` 将 allAreFullyDisrupted 设为 false，将 newState 保存在 newZoneStates 中;
- 3、将 allWasFullyDisrupted 默认值设置为 true，根据 zoneStates 中 nodeCondition 的数据，判断上一次观察到的所有 zone 是否都为 `FullDisruption` 状态；
- 4、如果所有 zone 都为 `FullyDisrupted` 直接停止所有的驱逐工作，因为此时可能处于网络中断的状态；
- 5、如果 allAreFullyDisrupted 为 true，allWasFullyDisrupted 为 false，说明从非 `FullyDisrupted` 切换到了 `FullyDisrupted` 模式，此时需要停止所有 node 的驱逐工作，首先去掉 node 上的 taint 并设置所有zone的对应 zoneNoExecuteTainter 或者 zonePodEvictor 的 Rate Limeter 为0，最后更新所有 zone 的状态为 `FullDisruption`；
- 6、如果 allWasFullyDisrupted 为 true，allAreFullyDisrupted 为 false，说明集群从 `FullyDisrupted` 变为 非 `FullyDisrupted` 模式，此时首先更新 `nc.nodeHealthMap` 中所有 node 的 probeTimestamp 和 readyTransitionTimestamp 为当前时间，然后调用 `nc.setLimiterInZone` 重置每个 zone 的驱逐速率；
- 7、如果 allWasFullyDisrupted为false 且 allAreFullyDisrupted 为false，即集群状态保持为非 `FullDisruption` 时，此时根据 zone 的 state 为每个 zone 设置默认的驱逐速率；



`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:1017`

```
func (nc *Controller) handleDisruption(zoneToNodeConditions map[string][]*v1.NodeCondition, nodes []*v1.Node) {
    newZoneStates := map[string]ZoneState{}
    allAreFullyDisrupted := true
    
    // 1、判断当前所有 zone 是否都为 FullDisruption 状态
    for k, v := range zoneToNodeConditions {
        zoneSize.WithLabelValues(k).Set(float64(len(v)))
        // 2、计算 zone state 以及 unhealthy node
        unhealthy, newState := nc.computeZoneStateFunc(v)
        zoneHealth.WithLabelValues(k).Set(float64(100*(len(v)-unhealthy)) / float64(len(v)))
        unhealthyNodes.WithLabelValues(k).Set(float64(unhealthy))
        if newState != stateFullDisruption {
            allAreFullyDisrupted = false
        }
        newZoneStates[k] = newState
        if _, had := nc.zoneStates[k]; !had {
            nc.zoneStates[k] = stateInitial
        }
    }

    // 3、判断上一次观察到的所有 zone 是否都为 FullDisruption 状态
    allWasFullyDisrupted := true
    for k, v := range nc.zoneStates {
        if _, have := zoneToNodeConditions[k]; !have {
            zoneSize.WithLabelValues(k).Set(0)
            zoneHealth.WithLabelValues(k).Set(100)
            unhealthyNodes.WithLabelValues(k).Set(0)
            delete(nc.zoneStates, k)
            continue
        }
        if v != stateFullDisruption {
            allWasFullyDisrupted = false
            break
        }
    }
    // 4、若存在一个不为 FullyDisrupted 
    if !allAreFullyDisrupted || !allWasFullyDisrupted {
        // 5、如果 allAreFullyDisrupted 为 true，则 allWasFullyDisrupted 为 false
        //   说明从非 FullyDisrupted 切换到了 FullyDisrupted 模式
        if allAreFullyDisrupted {
            for i := range nodes {
                if nc.useTaintBasedEvictions {
                    _, err := nc.markNodeAsReachable(nodes[i])
                    if err != nil {
                        klog.Errorf("Failed to remove taints from Node %v", nodes[i].Name)
                    }
                } else {
                    nc.cancelPodEviction(nodes[i])
                }
            }
            
            for k := range nc.zoneStates {
                if nc.useTaintBasedEvictions {
                    nc.zoneNoExecuteTainter[k].SwapLimiter(0)
                } else {
                    nc.zonePodEvictor[k].SwapLimiter(0)
                }
            }
            for k := range nc.zoneStates {
                nc.zoneStates[k] = stateFullDisruption
            }
            return
        }
        // 6、如果 allWasFullyDisrupted 为 true，则 allAreFullyDisrupted 为 false
        //   说明 cluster 从 FullyDisrupted 切换为非 FullyDisrupted 模式
        if allWasFullyDisrupted {
            now := nc.now()
            for i := range nodes {
                v := nc.nodeHealthMap[nodes[i].Name]
                v.probeTimestamp = now
                v.readyTransitionTimestamp = now
                nc.nodeHealthMap[nodes[i].Name] = v
            }

            for k := range nc.zoneStates {
                nc.setLimiterInZone(k, len(zoneToNodeConditions[k]), newZoneStates[k])
                nc.zoneStates[k] = newZoneStates[k]
            }
            return
        }

        // 7、根据 zoneState 为每个 zone 设置驱逐速率
        for k, v := range nc.zoneStates {
            newState := newZoneStates[k]
            if v == newState {
                continue
            }

            nc.setLimiterInZone(k, len(zoneToNodeConditions[k]), newState)
            nc.zoneStates[k] = newState
        }
    }
}
```



###### nc.computeZoneStateFunc

`nc.computeZoneStateFunc` 是计算 zone state 的方法，该方法会计算每个 zone 下 notReady 的 node 并将 zone 分为三种：
- `fullyDisrupted`：zone 下所有 node 都处于 notReady 状态；
- `partiallyDisrupted`：notReady node 占比 >= unhealthyZoneThreshold 的值(默认为0.55，通过`--unhealthy-zone-threshold`设置)且 notReady node 数超过2个；
- `normal`：以上两种情况之外的；


`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:1262`

```
func (nc *Controller) ComputeZoneState(nodeReadyConditions []*v1.NodeCondition) (int, ZoneState) {
    readyNodes := 0
    notReadyNodes := 0
    for i := range nodeReadyConditions {
        if nodeReadyConditions[i] != nil && nodeReadyConditions[i].Status == v1.ConditionTrue {
            readyNodes++
        } else {
            notReadyNodes++
        }
    }
    switch {
    case readyNodes == 0 && notReadyNodes > 0:
        return notReadyNodes, stateFullDisruption
    case notReadyNodes > 2 && float32(notReadyNodes)/float32(notReadyNodes+readyNodes) >= nc.unhealthyZoneThreshold:
        return notReadyNodes, statePartialDisruption
    default:
        return notReadyNodes, stateNormal
    }
}
```



###### nc.setLimiterInZone

`nc.setLimiterInZone` 方法会根据不同的 zoneState 设置对应的驱逐速率：
- `stateNormal` ：驱逐速率为 evictionLimiterQPS（默认为0.1，可以通过 `--node-eviction-rate` 参数指定)的值，即每隔 10s 清空一个节点；
- `statePartialDisruption`：如果当前 zone size 大于 `nc.largeClusterThreshold`（默认为 50，通过`--large-cluster-size-threshold`设置），则设置为 secondaryEvictionLimiterQPS（默认为 0.01，可以通过 `--secondary-node-eviction-rate` 指定），否则设置为 0；
- `stateFullDisruption`：为 evictionLimiterQPS（默认为0.1，可以通过 `--node-eviction-rate` 参数指定)的值；



`k8s.io/kubernetes/pkg/controller/nodelifecycle/node_lifecycle_controller.go:1115`

```
func (nc *Controller) setLimiterInZone(zone string, zoneSize int, state ZoneState) {
    switch state {
    case stateNormal:
        if nc.useTaintBasedEvictions {
            nc.zoneNoExecuteTainter[zone].SwapLimiter(nc.evictionLimiterQPS)
        } else {
            nc.zonePodEvictor[zone].SwapLimiter(nc.evictionLimiterQPS)
        }
    case statePartialDisruption:
        if nc.useTaintBasedEvictions {
            nc.zoneNoExecuteTainter[zone].SwapLimiter(
                nc.enterPartialDisruptionFunc(zoneSize))
        } else {
            nc.zonePodEvictor[zone].SwapLimiter(
                nc.enterPartialDisruptionFunc(zoneSize))
        }
    case stateFullDisruption:
        if nc.useTaintBasedEvictions {
            nc.zoneNoExecuteTainter[zone].SwapLimiter(
                nc.enterFullDisruptionFunc(zoneSize))
        } else {
            nc.zonePodEvictor[zone].SwapLimiter(
                nc.enterFullDisruptionFunc(zoneSize))
        }
    }
}
```



##### 小结

monitorNodeHealth 中的主要流程如下所示：

```
                               monitorNodeHealth
                                      |
                                      |
                            useTaintBasedEvictions
                                      |
                                      |
               ---------------------------------------------
           yes |                                           | no
               |                                           |
               v                                           v
       addPodEvictorForNewZone                         evictPods
               |                                           |
               |                                           |
               v                                           v
       zoneNoExecuteTainter                         zonePodEvictor
    (RateLimitedTimedQueue)                     (RateLimitedTimedQueue)
               |                                           |
               |                                           |
               |                                           |
               v                                           v
       doNoExecuteTaintingPass                       doEvictionPass
           (consumer)                                 (consumer)
```


NodeLifecycleController 中三个核心组件之间的交互流程如下所示:

```
                            monitorNodeHealth
                                    |
                                    |
                                    | 为 node 添加 NoExecute taint
                                    |
                                    |
                                    v       为 node 添加
                 watch nodeList           NoSchedule taint
     taintManager   ------>     APIServer  <-----------  nc.doNodeProcessingPassWorker
           |
           |
           |
           v
    驱逐 node 上不容忍
    node taint 的 pod 
```


至此，NodeLifecycleController 的核心代码已经分析完。



### 总结

本文主要分析了 NodeLifecycleController 的设计与实现，NodeLifecycleController 主要是监控 node 状态，当 node 异常时驱逐 node 上的 pod，其行为与其他组件有一定关系，node 的状态由 kubelet 上报，node 异常时为 node 添加 taint 标签后，scheduler 调度 pod 也会有对应的行为。为了保证由于网络等问题引起的 pod 驱逐行为，NodeLifecycleController 会为 node 进行分区并会为每个区设置不同的驱逐速率，即实际上会以 rate-limited 的方式添加 taint，在某些情况下可以避免 pod 被大量驱逐。

此外，NodeLifecycleController 还会对外暴露多个 metrics，包括 zoneHealth、zoneSize、unhealthyNodes、evictionsNumber 等，便于用户查看集群下 node 的状态。



参考：

https://kubernetes.io/zh/docs/concepts/configuration/taint-and-toleration/

https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/


---
title: statefulset controller 源码分析
date: 2019-12-11 20:40:30
tags: ["kube-controller-manager","statefulset controller"]
type: "statefulset controller"

---

* [Statefulset 的基本功能](#statefulset-的基本功能)
   * [创建](#创建)
   * [扩容](#扩容)
   * [缩容](#缩容)
   * [更新](#更新)
   * [回滚](#回滚)
   * [删除](#删除)
   * [Pod 管理策略](#pod-管理策略)
* [StatefulSetController 源码分析](#statefulsetcontroller-源码分析)
   * [sync](#sync)
   * [syncStatefulSet](#syncstatefulset)
   * [updateStatefulSet](#updatestatefulset)
* [总结](#总结)



### Statefulset 的基本功能

statefulset 旨在与有状态的应用及分布式系统一起使用，statefulset 中的每个 pod 拥有一个唯一的身份标识，并且所有 pod 名都是按照 {0..N-1} 的顺序进行编号。本文会主要分析 statefulset controller 的设计与实现，在分析源码前先介绍一下 statefulset 的基本使用。



#### 创建

对于一个拥有 N 个副本的 statefulset，pod 是按照 {0..N-1}的序号顺序创建的，并且会等待前一个 pod 变为 `Running & Ready` 后才会启动下一个 pod。

```
$ kubectl create -f sts.yaml

$ kubectl get pod -o wide -w
NAME    READY   STATUS              RESTARTS   AGE   IP       NODE
web-0   0/1     ContainerCreating   0          20s   <none>   minikube
web-0   1/1     Running             0          3m1s   10.1.0.8   minikube

web-1   0/1     Pending             0          0s     <none>     <none>
web-1   0/1     ContainerCreating   0          2s     <none>     minikube
web-1   1/1     Running             0          4s     10.1.0.9   minikube

```

#### 扩容

statefulset 扩容时 pod 也是顺序创建的，编号与前面的 pod 相接。

```
$ kubectl scale sts web --replicas=4
statefulset.apps/web scaled

$ kubectl get pod -o wide -w
......
web-2   0/1     Pending             0          0s     <none>     <none>
web-2   0/1     ContainerCreating   0          1s     <none>     minikube
web-2   1/1     Running             0          4s     10.1.0.10   minikube

web-3   0/1     Pending             0          0s     <none>      <none>
web-3   0/1     ContainerCreating   0          1s     <none>      minikube
web-3   1/1     Running             0          4s     10.1.0.11   minikube
```

#### 缩容

缩容时控制器会按照与 pod 序号索引相反的顺序每次删除一个 pod，在删除下一个 pod 前会等待上一个被完全删除。

```
$ kubectl scale sts web --replicas=2

$ kubectl get pod -o wide -w
......
web-3   1/1     Terminating         0          8m25s   10.1.0.11   minikube
web-3   0/1     Terminating         0          8m27s   <none>      minikube

web-2   1/1     Terminating         0          8m31s   10.1.0.10   minikube
web-2   0/1     Terminating         0          8m33s   10.1.0.10   minikube
```



#### 更新

更新策略由 statefulset 中的 `spec.updateStrategy.type` 字段决定，可以指定为 `OnDelete` 或者 `RollingUpdate` , 默认的更新策略为  `RollingUpdate`。当使用`RollingUpdate` 更新策略更新所有 pod 时采用与序号索引相反的顺序进行更新，即最先删除序号最大的 pod 并根据更新策略中的 `partition` 参数来进行分段更新，控制器会更新所有序号大于或等于  `partition` 的 pod，等该区间内的 pod 更新完成后需要再次设定  `partition`  的值以此来更新剩余的 pod，最终  `partition`  被设置为 0 时代表更新完成了所有的 pod。在更新过程中，如果一个序号小于 `partition` 的 pod 被删除或者终止，controller 依然会使用更新前的配置重新创建。

```
// 使用 RollingUpdate 策略更新
$ kubectl patch statefulset web --type='json' -p='[{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value":"nginx:1.16"}]'

statefulset.apps/web patched

$ kubectl rollout status sts/web
Waiting for 1 pods to be ready...
Waiting for partitioned roll out to finish: 1 out of 2 new pods have been updated...
Waiting for 1 pods to be ready...
partitioned roll out complete: 2 new pods have been updated...
```



如果 statefulset 的 `.spec.updateStrategy.type` 字段被设置为 `OnDelete`，在更新 statefulset 时，statefulset controller 将不会自动更新其 pod。你必须手动删除 pod，此时 statefulset controller 在重新创建 pod 时，使用修改过的 `.spec.template` 的内容创建新 pod。

```
// 使用 OnDelete 方式更新
$ kubectl patch statefulset nginx --type='json' -p='[{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value":"nginx:1.9"}]'

// 删除 web-1
$ kubectl delete pod web-1

// 查看 web-0 与 web-1 的镜像版本，此时发现 web-1 已经变为最新版本 nginx:1.9 了
$ kubectl get pod -l app=nginx -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
web-0	nginx:1.16
web-1	nginx:1.9
```



使用滚动更新策略时你必须以某种策略不段更新 `partition` 值来进行升级，类似于金丝雀部署方式，升级对于 pod 名称来说是逆序。使用非滚动更新方式式，需要手动删除对应的 pod，升级可以是无序的。

#### 回滚

statefulset 和 deployment 一样也支持回滚操作，statefulset 也保存了历史版本，和 deployment 一样利用`.spec.revisionHistoryLimit` 字段设置保存多少个历史版本，但 statefulset 的回滚并不是自动进行的，回滚操作也仅仅是进行了一次发布更新，和发布更新的策略一样，更新 statefulset  后需要按照对应的策略手动删除 pod 或者修改 `partition` 字段以达到回滚 pod 的目的。

```
// 查看 sts 的历史版本
$ kubectl rollout history statefulset web
statefulset.apps/web
REVISION
0
0
5
6

$ kubectl get controllerrevision
NAME             CONTROLLER             REVISION   AGE
web-6c4c79564f   statefulset.apps/web   6          11m
web-c47b9997f    statefulset.apps/web   5          4h13m

// 回滚至最近的一个版本
$ kubectl rollout undo statefulset web --to-revision=5
```



因为 statefulset 的使用对象是有状态服务，大部分有状态副本集都会用到持久存储，statefulset 下的每个 pod 正常情况下都会关联一个 pv 对象，对 statefulset 对象回滚非常容易，但其使用的 pv 中保存的数据无法回滚，所以在生产环境中进行回滚时需要谨慎操作，statefulset、pod、pvc 和 pv 关系图如下所示：

![](http://cdn.tianfeiyu.com/format-sts.png)



#### 删除

statefulset 同时支持级联和非级联删除。使用非级联方式删除 statefulset 时，statefulset 的 pod 不会被删除。使用级联删除时，statefulset 和它关联的 pod 都会被删除。对于级联与非级联删除，在删除时需要指定删除选项(`orphan`、`background` 或者 `foreground`)进行区分。

```
// 1、非级联删除
$ kubectl delete statefulset web --cascade=false

// 删除 sts 后 pod 依然处于运行中
$ kubectl get pod
NAME    READY   STATUS    RESTARTS   AGE
web-0   1/1     Running   0          4m38s
web-1   1/1     Running   0          17m

// 重新创建 sts 后，会再次关联所有的 pod
$ kubectl create  -f  sts.yaml

$ kubectl get sts
NAME   READY   AGE
web    2/2     28s
```



在级联删除 statefulset 时，会将所有的 pod 同时删掉，statefulset 控制器会首先进行一个类似缩容的操作，pod 按照和他们序号索引相反的顺序每次终止一个。在终止一个 pod 前，statefulset 控制器会等待 pod 后继者被完全终止。

```
// 2、级联删除
$ kubectl delete statefulset web

$ kubectl get pod -o wide -w
......
web-0   1/1     Terminating   0          17m   10.1.0.18   minikube   <none>           <none>
web-1   1/1     Terminating   0          36m   10.1.0.15   minikube   <none>           <none>
web-1   0/1     Terminating   0          36m   10.1.0.15   minikube   <none>           <none>
web-0   0/1     Terminating   0          17m   10.1.0.18   minikube   <none>           <none>
```



#### Pod 管理策略

statefulset 的默认管理策略是 `OrderedReady`，该策略遵循上文展示的顺序性保证。statefulset 还有另外一种管理策略 `Parallel`，`Parallel` 管理策略告诉 statefulset 控制器并行的终止所有 pod，在启动或终止另一个 pod 前，不必等待这些 pod 变成 `Running & Ready` 或者完全终止状态，但是 `Parallel` 仅仅支持在 `OnDelete` 策略下生效，下文会在源码中具体分析。



###  StatefulSetController 源码分析

> kubernetes 版本：v1.16



`startStatefulSetController` 是 statefulSetController 的启动方法，其中调用 `NewStatefulSetController` 进行初始化 controller 对象然后调用 `Run` 方法启动 controller。其中 `ConcurrentStatefulSetSyncs` 默认值为 5。



`k8s.io/kubernetes/cmd/kube-controller-manager/app/apps.go:55`

```
func startStatefulSetController(ctx ControllerContext) (http.Handler, bool, error) {
    if !ctx.AvailableResources[schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}] {
        return nil, false, nil
    }
    go statefulset.NewStatefulSetController(
        ctx.InformerFactory.Core().V1().Pods(),
        ctx.InformerFactory.Apps().V1().StatefulSets(),
        ctx.InformerFactory.Core().V1().PersistentVolumeClaims(),
        ctx.InformerFactory.Apps().V1().ControllerRevisions(),
        ctx.ClientBuilder.ClientOrDie("statefulset-controller"),
    ).Run(int(ctx.ComponentConfig.StatefulSetController.ConcurrentStatefulSetSyncs), ctx.Stop)
    return nil, true, nil
}
```



当 controller 启动后会通过 informer 同步 cache 并监听 pod 和 statefulset 对象的变更事件，informer 的处理流程此处不再详细讲解，最后会执行 `sync` 方法，`sync` 方法是每个 controller 的核心方法，下面直接看 statefulset controller 的 `sync` 方法。



#### sync

sync 方法的主要逻辑为：

- 1、根据 ns/name 获取 sts 对象；
- 2、获取 sts 的 selector；
- 3、调用 `ssc.adoptOrphanRevisions` 检查是否有孤儿 `controllerrevisions` 对象，若有且能匹配 selector 的则添加 ownerReferences 进行关联，已关联但 label 不匹配的则进行释放；
- 4、调用 `ssc.getPodsForStatefulSet` 通过 selector 获取 sts 关联的 pod，若有孤儿 pod 的 label 与 sts 的能匹配则进行关联，若已关联的 pod label 有变化则解除与 sts 的关联关系；
- 5、最后调用 `ssc.syncStatefulSet` 执行真正的 sync 操作；



`k8s.io/kubernetes/pkg/controller/statefulset/stateful_set.go:408`

```
func (ssc *StatefulSetController) sync(key string) error {
    ......

    namespace, name, err := cache.SplitMetaNamespaceKey(key)
    if err != nil {
        return err
    }
    
    // 1、获取 sts 对象
    set, err := ssc.setLister.StatefulSets(namespace).Get(name)
    ......

    selector, err := metav1.LabelSelectorAsSelector(set.Spec.Selector)
    ......
    
    // 2、关联以及释放 sts 的 controllerrevisions
    if err := ssc.adoptOrphanRevisions(set); err != nil {
        return err
    }

    // 3、获取 sts 所关联的 pod 
    pods, err := ssc.getPodsForStatefulSet(set, selector)
    if err != nil {
        return err
    }

    return ssc.syncStatefulSet(set, pods)
}
```



#### syncStatefulSet

在 `syncStatefulSet` 中仅仅是调用了 `ssc.control.UpdateStatefulSet` 方法进行处理。`ssc.control.UpdateStatefulSet` 会调用 `defaultStatefulSetControl` 的 `UpdateStatefulSet` 方法，`defaultStatefulSetControl` 是 statefulset controller 中另外一个对象，主要负责处理 statefulset 的更新。



`k8s.io/kubernetes/pkg/controller/statefulset/stateful_set.go:448`

```
func (ssc *StatefulSetController) syncStatefulSet(set *apps.StatefulSet, pods []*v1.Pod) error {
    ......
    if err := ssc.control.UpdateStatefulSet(set.DeepCopy(), pods); err != nil {
        return err
    }
    ......
    return nil
}
```



`UpdateStatefulSet` 方法的主要逻辑如下所示：

- 1、获取历史 revisions；
- 2、计算 `currentRevision` 和 `updateRevision`，若 sts 处于更新过程中则 `currentRevision` 和 `updateRevision` 值不同；
- 3、调用 `ssc.updateStatefulSet` 执行实际的 sync 操作；
- 4、调用 `ssc.updateStatefulSetStatus` 更新 status subResource；
- 5、根据 sts 的 `spec.revisionHistoryLimit`字段清理过期的 `controllerrevision`；



在基本操作的回滚阶段提到了过，sts 通过 `controllerrevision` 保存历史版本，类似于 deployment 的 replicaset，与 replicaset 不同的是 controllerrevision 仅用于回滚阶段，在 sts 的滚动升级过程中是通过 `currentRevision` 和 `updateRevision`来j进行控制并不会用到 `controllerrevision`。



`k8s.io/kubernetes/pkg/controller/statefulset/stateful_set_control.go:75`

```
func (ssc *defaultStatefulSetControl) UpdateStatefulSet(set *apps.StatefulSet, pods []*v1.Pod) error {

    // 1、获取历史 revisions 
    revisions, err := ssc.ListRevisions(set)
    if err != nil {
        return err
    }
    history.SortControllerRevisions(revisions)

    // 2、计算 currentRevision 和 updateRevision
    currentRevision, updateRevision, collisionCount, err := ssc.getStatefulSetRevisions(set, revisions)
    if err != nil {
        return err
    }

    // 3、执行实际的 sync 操作
    status, err := ssc.updateStatefulSet(set, currentRevision, updateRevision, collisionCount, pods)
    if err != nil {
        return err
    }

    // 4、更新 sts 状态
    err = ssc.updateStatefulSetStatus(set, status)
    if err != nil {
        return err
    }
    ......

    // 5、清理过期的历史版本
    return ssc.truncateHistory(set, pods, revisions, currentRevision, updateRevision)
}
```



#### updateStatefulSet

`updateStatefulSet` 是 sync 操作中的核心方法，对于 statefulset 的创建、扩缩容、更新、删除等操作都会在这个方法中完成，以下是其主要逻辑：

- 1、分别获取 `currentRevision` 和 `updateRevision` 对应的的 statefulset object；
- 2、构建 status 对象；
- 3、将 statefulset 的 pods 按 ord(ord 为 pod name 中的序号)的值分到 replicas 和 condemned 两个数组中，0 <= ord < Spec.Replicas 的放到 replicas 组，ord >= Spec.Replicas 的放到 condemned 组，replicas 组代表可用的 pod，condemned 组是需要删除的 pod；
- 4、找出 replicas 和 condemned 组中的 unhealthy pod，healthy pod 指 `running & ready` 并且不处于删除状态；
- 5、判断 sts 是否处于删除状态；
- 6、遍历 replicas 数组，确保 replicas 数组中的容器处于 `running & ready`状态，其中处于 `failed` 状态的容器删除重建，未创建的容器则直接创建，最后检查 pod 的信息是否与 statefulset 的匹配，若不匹配则更新 pod 的状态。在此过程中每一步操作都会检查 `monotonic` 的值，即 sts 是否设置了 `Parallel` 参数，若设置了则循环处理 replicas 中的所有 pod，否则每次处理一个 pod，剩余 pod 则在下一个 syncLoop 继续进行处理；
- 7、按 pod 名称逆序删除 `condemned` 数组中的 pod，删除前也要确保 pod 处于 `running & ready`状态，在此过程中也会检查 `monotonic` 的值，以此来判断是顺序删除还是在下一个 syncLoop 中继续进行处理；
- 8、判断 sts 的更新策略 `.Spec.UpdateStrategy.Type`，若为 `OnDelete` 则直接返回；
- 9、此时更新策略为 `RollingUpdate`，更新序号大于等于 `.Spec.UpdateStrategy.RollingUpdate.Partition` 的 pod，在 `RollingUpdate` 时，并不会关注 `monotonic` 的值，都是顺序进行处理且等待当前 pod 删除成功后才继续删除小于上一个 pod 序号的 pod，所以 `Parallel` 的策略在滚动更新时无法使用。



`updateStatefulSet` 这个方法中包含了 statefulset 的创建、删除、扩若容、更新等操作，在源码层面对于各个功能无法看出明显的界定，没有 deployment sync 方法中写的那么清晰，下面还是按 statefulset 的功能再分析一下具体的操作：
- 创建：在创建 sts 后，sts 对象已被保存至 etcd 中，此时 sync 操作仅仅是创建出需要的 pod，即执行到第 6 步就会结束；
- 扩缩容：对于扩若容操作仅仅是创建或者删除对应的 pod，在操作前也会判断所有 pod 是否处于 `running & ready`状态，然后进行对应的创建/删除操作，在上面的步骤中也会执行到第 6 步就结束了；
- 更新：可以看出在第六步之后的所有操作就是与更新相关的了，所以更新操作会执行完整个方法，在更新过程中通过 pod 的 `currentRevision` 和 `updateRevision` 来计算 `currentReplicas`、`updatedReplicas` 的值，最终完成所有 pod 的更新；
- 删除：删除操作就比较明显了，会止于第五步，但是在此之前检查 pod 状态以及分组的操作确实是多余的；



`k8s.io/kubernetes/pkg/controller/statefulset/stateful_set_control.go:255`

```
func (ssc *defaultStatefulSetControl) updateStatefulSet(......) (*apps.StatefulSetStatus, error) {
    // 1、分别获取 currentRevision 和 updateRevision 对应的的 statefulset object
    currentSet, err := ApplyRevision(set, currentRevision)
    if err != nil {
        return nil, err
    }
    updateSet, err := ApplyRevision(set, updateRevision)
    if err != nil {
        return nil, err
    }

    // 2、计算 status
    status := apps.StatefulSetStatus{}
    status.ObservedGeneration = set.Generation
    status.CurrentRevision = currentRevision.Name
    status.UpdateRevision = updateRevision.Name
    status.CollisionCount = new(int32)
    *status.CollisionCount = collisionCount


    // 3、将 statefulset 的 pods 按 ord(ord 为 pod name 中的序数)的值
    // 分到 replicas 和 condemned 两个数组中
    replicaCount := int(*set.Spec.Replicas)
    replicas := make([]*v1.Pod, replicaCount)
    condemned := make([]*v1.Pod, 0, len(pods))
    unhealthy := 0
    firstUnhealthyOrdinal := math.MaxInt32
    
    var firstUnhealthyPod *v1.Pod

    // 4、计算 status 字段中的值，将 pod 分配到 replicas和condemned两个数组中
    for i := range pods {
        status.Replicas++

        if isRunningAndReady(pods[i]) {
            status.ReadyReplicas++
        }

        if isCreated(pods[i]) && !isTerminating(pods[i]) {
            if getPodRevision(pods[i]) == currentRevision.Name {
                status.CurrentReplicas++
            }
            if getPodRevision(pods[i]) == updateRevision.Name {
                status.UpdatedReplicas++
            }
        }

        if ord := getOrdinal(pods[i]); 0 <= ord && ord < replicaCount {
            replicas[ord] = pods[i]
        } else if ord >= replicaCount {
            condemned = append(condemned, pods[i])
        }
    }

    // 5、检查 replicas数组中 [0,set.Spec.Replicas) 下标是否有缺失的 pod，若有缺失的则创建对应的 pod object 
	// 在 newVersionedStatefulSetPod 中会判断是使用 currentSet 还是 updateSet 来创建
    for ord := 0; ord < replicaCount; ord++ {
        if replicas[ord] == nil {
            replicas[ord] = newVersionedStatefulSetPod(
                currentSet,
                updateSet,
                currentRevision.Name,
                updateRevision.Name, ord)
        }
    }

    // 6、对 condemned 数组进行排序
    sort.Sort(ascendingOrdinal(condemned))

    // 7、根据 ord 在 replicas 和 condemned 数组中找出 first unhealthy Pod 
    for i := range replicas {
        if !isHealthy(replicas[i]) {
            unhealthy++
            if ord := getOrdinal(replicas[i]); ord < firstUnhealthyOrdinal {
                firstUnhealthyOrdinal = ord
                firstUnhealthyPod = replicas[i]
            }
        }
    }

    for i := range condemned {
        if !isHealthy(condemned[i]) {
            unhealthy++
            if ord := getOrdinal(condemned[i]); ord < firstUnhealthyOrdinal {
                firstUnhealthyOrdinal = ord
                firstUnhealthyPod = condemned[i]
            }
        }
    }

    ......

    // 8、判断是否处于删除中
    if set.DeletionTimestamp != nil {
        return &status, nil
    }

    // 9、默认设置为非并行模式
    monotonic := !allowsBurst(set)


    // 10、确保 replicas 数组中所有的 pod 是 running 的
    for i := range replicas {
        // 11、对于 failed 的 pod 删除并重新构建 pod object
        if isFailed(replicas[i]) {
            ......
            if err := ssc.podControl.DeleteStatefulPod(set, replicas[i]); err != nil {
                return &status, err
            }
            if getPodRevision(replicas[i]) == currentRevision.Name {
                status.CurrentReplicas--
            }
            if getPodRevision(replicas[i]) == updateRevision.Name {
                status.UpdatedReplicas--
            }
            status.Replicas--
            replicas[i] = newVersionedStatefulSetPod(
                currentSet,
                updateSet,
                currentRevision.Name,
                updateRevision.Name,
                i)
        }
        
        // 12、如果 pod.Status.Phase 不为“” 说明该 pod 未创建，则直接重新创建该 pod
        if !isCreated(replicas[i]) {
            if err := ssc.podControl.CreateStatefulPod(set, replicas[i]); err != nil {
                return &status, err
            }
            status.Replicas++
            if getPodRevision(replicas[i]) == currentRevision.Name {
                status.CurrentReplicas++
            }
            if getPodRevision(replicas[i]) == updateRevision.Name {
                status.UpdatedReplicas++
            }

            // 13、如果为Parallel，直接return status结束；如果为OrderedReady，循环处理下一个pod。
            if monotonic {
                return &status, nil
            }
            continue
        }
        
        // 14、如果pod正在删除(pod.DeletionTimestamp不为nil)，且Spec.PodManagementPolicy不
        // 为Parallel，直接return status结束，结束后会在下一个 syncLoop 继续进行处理，
        // pod 状态的改变会触发下一次 syncLoop
        if isTerminating(replicas[i]) && monotonic {
            ......
            return &status, nil
        }
        
        // 15、如果pod状态不是Running & Ready，且Spec.PodManagementPolicy不为Parallel，
        // 直接return status结束
        if !isRunningAndReady(replicas[i]) && monotonic {
            ......
            return &status, nil
        }
        
        // 16、检查 pod 的信息是否与 statefulset 的匹配，若不匹配则更新 pod 的状态
        if identityMatches(set, replicas[i]) && storageMatches(set, replicas[i]) {
            continue
        }

        replica := replicas[i].DeepCopy()
        if err := ssc.podControl.UpdateStatefulPod(updateSet, replica); err != nil {
            return &status, err
        }
    }

		
    // 17、逆序处理 condemned 中的 pod
    for target := len(condemned) - 1; target >= 0; target-- {
    
        // 18、如果pod正在删除，检查 Spec.PodManagementPolicy 的值，如果为Parallel，
        // 循环处理下一个pod 否则直接退出
        if isTerminating(condemned[target]) {
            ......
            if monotonic {
                return &status, nil
            }
            continue
        }

        
        // 19、不满足以下条件说明该 pod 是更新前创建的，正处于创建中
        if !isRunningAndReady(condemned[target]) && monotonic && condemned[target] != firstUnhealthyPod {
            ......
            return &status, nil
        }
            
        // 20、否则直接删除该 pod
        if err := ssc.podControl.DeleteStatefulPod(set, condemned[target]); err != nil {
            return &status, err
        }
        if getPodRevision(condemned[target]) == currentRevision.Name {
            status.CurrentReplicas--
        }
        if getPodRevision(condemned[target]) == updateRevision.Name {
            status.UpdatedReplicas--
        }
        
        // 21、如果为 OrderedReady 方式则返回否则继续处理下一个 pod
        if monotonic {
            return &status, nil
        }
    }

    // 22、对于 OnDelete 策略直接返回
    if set.Spec.UpdateStrategy.Type == apps.OnDeleteStatefulSetStrategyType {
        return &status, nil
    }

    // 23、若为 RollingUpdate 策略，则倒序处理 replicas数组中下标大于等于		
    // 	   Spec.UpdateStrategy.RollingUpdate.Partition 的 pod
    updateMin := 0
    if set.Spec.UpdateStrategy.RollingUpdate != nil {
        updateMin = int(*set.Spec.UpdateStrategy.RollingUpdate.Partition)
    }

    for target := len(replicas) - 1; target >= updateMin; target-- {
        // 24、如果Pod的Revision 不等于 updateRevision，且 pod 没有处于删除状态则直接删除 pod
        if getPodRevision(replicas[target]) != updateRevision.Name && !isTerminating(replicas[target]) {
            ......
            err := ssc.podControl.DeleteStatefulPod(set, replicas[target])
            status.CurrentReplicas--
            return &status, err
        }

        // 25、如果 pod 非 healthy 状态直接返回
        if !isHealthy(replicas[target]) {
            return &status, nil
        }
    }
    return &status, nil
}
```





### 总结

本文分析了 statefulset controller 的主要功能，statefulset  在设计上有很多功能与 deployment 是类似的，但其主要是用来部署有状态应用的，statefulset 中的 pod 名称存在顺序性和唯一性，同时每个 pod 都使用了 pv 和 pvc 来存储状态，在创建、删除、更新操作中都会按照 pod 的顺序进行。



参考：

https://github.com/kubernetes/kubernetes/issues/78007

https://github.com/kubernetes/kubernetes/issues/67250

https://www.cnblogs.com/linuxk/p/9767736.html



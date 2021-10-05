---
title: kubernetes 中 Evicted pod 是如何产生的
date: 2021-03-01 15:31:30
tags: ["Evicted"]
type: "evicted pod"

---

* [线上被驱逐实例数据](#线上被驱逐实例数据)
* [实例被驱逐的原因](#实例被驱逐的原因)
   * [节点资源不足导致实例被驱逐](#节点资源不足导致实例被驱逐)
* [kubelet 驱逐实例时与资源处理相关的已知问题](#kubelet-驱逐实例时与资源处理相关的已知问题)
* [驱逐实例未被删除原因分析](#驱逐实例未被删除原因分析)
* [解决方案](#解决方案)
* [总结](#总结)


### 线上被驱逐实例数据

最近在线上发现很多实例处于 Evicted 状态，通过 pod yaml 可以看到实例是因为节点资源不足被驱逐，但是这些实例并没有被自动清理，平台的大部分用户在操作时看到服务下面出现 Evicted 实例时会以为服务有问题或者平台有问题的错觉，影响了用户的体验。而这部分 Evicted 状态的 Pod 在底层关联的容器其实已经被销毁了，对用户的服务也不会产生什么影响，也就是说只有一个 Pod 空壳在 k8s 中保存着，但需要人为手动清理。本文会分析为什么为产生 Evicted 实例、为什么 Evicted 实例没有被自动清理以及如何进行自动清理。

> kubernetes 版本：v1.17

```
$ kubectl get pod | grep -i Evicted
cloud-1023955-84421-49604-5-deploy-c-7748f8fd8-hjqsh        0/1     Evicted   0          73d
cloud-1023955-84421-49604-5-deploy-c-7748f8fd8-mzd8x        0/1     Evicted   0          81d
cloud-1237162-276467-199844-2-deploy-7bdc7c98b6-26r2r       0/1     Evicted   0          18d
```

Evicted 实例状态：

```
status:
  message: 'Pod The node had condition: [DiskPressure]. '
  phase: Failed
  reason: Evicted
  startTime: "2021-09-14T10:42:32Z"
```



### 实例被驱逐的原因

kubelet 默认会配置节点资源不足时驱逐实例的策略，当节点资源不足时 k8s 会停止该节点上实例并在其他节点启动新实例，在某些情况下也可通过配置 `--eviction-hard=` 参数为空来禁用驱逐策略，在之前的生产环境中我们也确实这么做了。

#### 节点资源不足导致实例被驱逐

k8s 中产生 Evicted 状态实例主要是因为节点资源不足实例主动被驱逐导致的，kubelet eviction_manager 模块会定期检查节点内存使用率、inode 使用率、磁盘使用率、pid 等资源，根据 kubelet 的配置当使用率达到一定阈值后会先回收可以回收的资源，若回收后资源使用率依然超过阈值则进行驱逐实例操作。

| Eviction Signal    | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| memory.available   | memory.available := node.status.capacity[memory] - node.stats.memory.workingSet |
| nodefs.available   | nodefs.available := node.stats.fs.available                  |
| nodefs.inodesFree  | nodefs.inodesFree := node.stats.fs.inodesFree                |
| imagefs.available  | imagefs.available := node.stats.runtime.imagefs.available    |
| imagefs.inodesFree | imagefs.inodesFree := node.stats.runtime.imagefs.inodesFree  |
| pid.available      | pid.available := node.stats.rlimit.maxpid - node.stats.rlimit.curproc |

kubelet 中 pod 的 stats 数据一部分是通过 cAdvisor 接口获取到的，一部分是通过 CRI runtimes 的接口获取到的。

**memory.available**：当前节点可用内存，计算方式为 cgroup memory 子系统中 memory.usage_in_bytes 中的值减去 memory.stat 中 total_inactive_file 的值；
**nodefs.available**：nodefs 包含 kubelet 配置中 `--root-dir` 指定的文件分区和 /var/lib/kubelet/ 所在的分区磁盘使用率；
**nodefs.inodesFree**：nodefs.available 分区的 inode 使用率；
**imagefs.available：**镜像所在分区磁盘使用率；
**imagefs.inodesFree：**镜像所在分区磁盘inode使用率；
**pid.available：**`/proc/sys/kernel/pid_max` 中的值为系统最大可用 pid 数；

kubelet 可以通过参数 `--eviction-hard` 来配置以上几个参数的阈值，该参数默认值为 `imagefs.available<15%,memory.available<100Mi,nodefs.available<10%,nodefs.inodesFree<5%`，当达到阈值时会驱逐节点上的容器。



### kubelet 驱逐实例时与资源处理相关的已知问题

**1、kubelet 不会实时感知到节点内存数据的变化**

kubelet 定期通过 cadvisor 接口采集节点内存使用数据，当节点短时间内内存使用率突增，此时 kubelet 无法感知到也不会有 MemoryPressure 相关事件，但依然会调用 OOMKiller 停止容器。可以通过为 kubelet 配置 `--kernel-memcg-notification` 参数启用 memcg api，当触发memory 使用率阈值时 memcg 会主动进行通知；

memcg 主动通知的功能是 cgroup 中已有的，kubelet 会在 `/sys/fs/cgroup/memory/cgroup.event_control` 文件中写入 memory.available 的阈值，而阈值与 inactive_file 文件的大小有关系，kubelet 也会定期更新阈值，当 memcg 使用率达到配置的阈值后会主动通知 kubelet，kubelet 通过 epoll 机制来接收通知。

**2、kubelet** **memory.available 不会计算 active page**

kubelet 通过内存使用率驱逐实例时，内存使用率数据包含了 page cache 中 active_file 的数据，在某些场景下会因 page cache 过高导致内存使用率超过阈值会造成实例被驱逐，

由于在内存紧张时 inactive_file 会被内核首先回收，但在内存不足时，active_file 也会被内核进行回收，社区对此机制也有一些疑问，针对内核回收内存的情况比较复杂，社区暂时还未进行回应，详情可以参考 [kubelet counts active page cache against memory.available (maybe it shouldn't?)](https://github.com/kubernetes/kubernetes/issues/43916)。

kubelet 计算节点可用内存的方式如下：

```
#!/bin/bash
#!/usr/bin/env bash

# This script reproduces what the kubelet does
# to calculate memory.available relative to root cgroup.

# current memory usage
memory_capacity_in_kb=$(cat /proc/meminfo | grep MemTotal | awk '{print $2}')
memory_capacity_in_bytes=$((memory_capacity_in_kb * 1024))
memory_usage_in_bytes=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes)
memory_total_inactive_file=$(cat /sys/fs/cgroup/memory/memory.stat | grep total_inactive_file | awk '{print $2}')

memory_working_set=${memory_usage_in_bytes}
if [ "$memory_working_set" -lt "$memory_total_inactive_file" ];
then
    memory_working_set=0
else
    memory_working_set=$((memory_usage_in_bytes - memory_total_inactive_file))
fi

memory_available_in_bytes=$((memory_capacity_in_bytes - memory_working_set))
memory_available_in_kb=$((memory_available_in_bytes / 1024))
memory_available_in_mb=$((memory_available_in_kb / 1024))

echo "memory.capacity_in_bytes $memory_capacity_in_bytes"
echo "memory.usage_in_bytes $memory_usage_in_bytes"
echo "memory.total_inactive_file $memory_total_inactive_file"
echo "memory.working_set $memory_working_set"
echo "memory.available_in_bytes $memory_available_in_bytes"
echo "memory.available_in_kb $memory_available_in_kb"
echo "memory.available_in_mb $memory_available_in_mb"
```



### 驱逐实例未被删除原因分析

源码中对于 Statefulset 和 DaemonSet 会自动删除 Evicted 实例，但是对于 Deployment 不会自动删除。阅读了部分官方文档以及 issue，暂未找到官方对 Deployment Evicted 实例未删除原因给出解释。

**statefulset：**
pkg/controller/statefulset/stateful_set_control.go
```
    // Examine each replica with respect to its ordinal
    for i := range replicas {
        // delete and recreate failed pods
        if isFailed(replicas[i]) {
            ssc.recorder.Eventf(set, v1.EventTypeWarning, "RecreatingFailedPod",
                "StatefulSet %s/%s is recreating failed Pod %s",
                set.Namespace,
                set.Name,
                replicas[i].Name)
            if err := ssc.podControl.DeleteStatefulPod(set, replicas[i]); err != nil {
                return &status, err
            }
            if getPodRevision(replicas[i]) == currentRevision.Name {
                status.CurrentReplicas--
            }
            if getPodRevision(replicas[i]) == updateRevision.Name {
                status.UpdatedReplicas--
            }
            ......
```


**daemonset：**
pkg/controller/daemon/daemon_controller.go
```
func (dsc *DaemonSetsController) podsShouldBeOnNode(
		......
) (nodesNeedingDaemonPods, podsToDelete []string) {

		......

    switch {
		......
    case shouldContinueRunning:
				......
        for _, pod := range daemonPods {
            if pod.DeletionTimestamp != nil {
                continue
            }
            if pod.Status.Phase == v1.PodFailed {
                // This is a critical place where DS is often fighting with kubelet that rejects pods.
                // We need to avoid hot looping and backoff.
                backoffKey := failedPodsBackoffKey(ds, node.Name)
                ......
```



### 解决方案

1、团队里面有了一套 k8s 集群事件采集的链路，我们通过消费 k8s 中 pod 的相关事件来进行处理，消费事件时过滤 pod 中与 Evicted 实例相关的事件然后处理即可。

Evicted 实例判断逻辑：

```
const (
	podEvictedStatus = "Evicted"
)

// 判断如果为 Evicted 状态的实例且 Pod 中容器数为 0 时直接删除 pod
if strings.ToLower(status) == strings.ToLower(podEvictedStatus) && len(pod.Status.ContainerStatuses) == 0 {

}
```



2、社区有人提供通过在 kube-controller-manager 中配置 podgc controller --terminated-pod-gc-threshold 参数来自动清理：

```
Podgc controller flags:

      --terminated-pod-gc-threshold int32
                Number of terminated pods that can exist before the terminated pod garbage collector starts deleting terminated pods. If
                <= 0, the terminated pod garbage collector is disabled. (default 12500)
```

该参数配置的是保留的异常实例数，默认值为 12500，但 podgc controller 回收 pod 时使用强杀模式不支持实例的优雅退出，因此暂不考虑使用。



3、其他处理方式可以参考社区中提供的 [Kubelet does not delete evicted pods](https://github.com/kubernetes/kubernetes/issues/55051)。



### 总结

由于在之前的公司中对于稳定性的高度重视，线上节点并未开启驱逐实例的功能，因此也不会存在 Evicted 状态的实例，当节点资源严重不足时会有告警人工介入处理，以及还会有二次调度、故障自愈等一些辅助处理措施。本次针对 Evicted 相关实例的分析，发现 k8s 与操作系统之间存在了很多联系，如果要彻底搞清楚某些机制需要对操作系统的一些原理有一定的了解。



参考：
https://github.com/kubernetes/kubernetes/issues/55051
https://ieevee.com/tech/2019/05/23/ephemeral-storage.html
https://github.com/kubernetes/kubernetes/issues/43916
https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/

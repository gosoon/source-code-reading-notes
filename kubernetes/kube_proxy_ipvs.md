---
title: kube-proxy ipvs 模式源码分析
date: 2019-11-18 11:40:30
tags: ["kube-proxy","ipvs"]
type: "kube-proxy"

---

前几篇文章已经分析了 service 的原理以及 kube-proxy  iptables 模式的原理与实现，本篇文章会继续分析 kube-proxy ipvs 模式的原理与实现。

### ipvs

ipvs (IP Virtual Server) 是基于 Netfilter 的，作为 linux 内核的一部分实现了传输层负载均衡，ipvs 集成在LVS(Linux Virtual Server)中，它在主机中运行，并在真实服务器集群前充当负载均衡器。ipvs 可以将对 TCP/UDP 服务的请求转发给后端的真实服务器，因此 ipvs 天然支持 Kubernetes Service。ipvs 也包含了多种不同的负载均衡算法，例如轮询、最短期望延迟、最少连接以及各种哈希方法等，ipvs 的设计就是用来为大规模服务进行负载均衡的。



#### ipvs 的负载均衡方式

ipvs 有三种负载均衡方式，分别为：

- [NAT](http://www.linuxvirtualserver.org/VS-NAT.html)
- [TUN](http://www.linuxvirtualserver.org/VS-IPTunneling.html)
- [DR](http://www.linuxvirtualserver.org/VS-DRouting.html)



关于三种模式的原理可以参考：[LVS 配置小结](http://www.tianfeiyu.com/?p=2010)。

上面的负载均衡方式中只有 NAT 模式可以进行端口映射，因此 kubernetes 中 ipvs 的实现使用了 NAT 模式，用来将 service IP 和 service port 映射到后端的 container ip 和container port。



NAT 模式下的工作流程如下所示：

```
   +--------+
   | Client |
   +--------+
     (CIP)       <-- Client's IP address
       |
       |
  { internet }
       |
       |
     (VIP)       <-- Virtual IP address
  +----------+
  | Director |
  +----------+
     (PIP)       <-- (Director's Private IP address)
       |
       |
     (RIP)       <-- Real (server's) IP address
 +-------------+
 | Real server |
 +-------------+
```

其具体流程为：当用户发起一个请求时，请求从 VIP 接口流入，此时数据源地址是 CIP，目标地址是 VIP，当接收到请求后拆掉 mac 地址封装后看到目标 IP 地址就是自己，按照正常流程会通过 INPUT 转入用户空间，但此时工作在 INPUT 链上的 ipvs 会强行将数据转到 POSTROUTING 链上，并根据相应的负载均衡算法选择后端具体的服务器，再通过 DNAT 转发给 Real server，此时源地址 CIP，目标地址变成了 RIP。



#### ipvs 与 iptables 的区别与联系

**区别**：

- 底层数据结构：iptables 使用链表，ipvs 使用哈希表
- 负载均衡算法：iptables 只支持随机、轮询两种负载均衡算法而 ipvs 支持的多达 8 种；
- 操作工具：iptables 需要使用 iptables 命令行工作来定义规则，ipvs 需要使用 ipvsadm 来定义规则。

此外 ipvs 还支持 realserver 运行状况检查、连接重试、端口映射、会话保持等功能。



**联系**：

ipvs 和 iptables 都是基于 [netfilter内核模块](https://www.netfilter.org/)，两者都是在内核中的五个钩子函数处工作，下图是 ipvs 所工作的几个钩子函数：





![interactions between netfilter and LVS](http://cdn.tianfeiyu.com/ipvs-1.png)

>  关于 kube-proxy iptables 与 ipvs 模式的区别，更多详细信息可以查看官方文档：https://github.com/kubernetes/kubernetes/blob/master/pkg/proxy/ipvs/README.md。



#### ipset

IP sets 是 Linux 内核中的一个框架，可以由 ipset 命令进行管理。根据不同的类型，IP set 可以以某种方式保存 IP地址、网络、(TCP/UDP)端口号、MAC地址、接口名或它们的组合，并且能够快速匹配。

根据官网的介绍，若有以下使用场景：

- 在保存了多个 IP 地址或端口号的 iptables 规则集合中想使用哈希查找;
- 根据 IP 地址或端口动态更新 iptables 规则时希望在性能上无损；
- 在使用 iptables 工具创建一个基于 IP 地址和端口的复杂规则时觉得非常繁琐；

此时，使用 ipset 工具可能是你最好的选择。



ipset 是 iptables 的一种扩展，在 iptables 中可以使用`-m set`启用 ipset 模块，具体来说，ipvs 使用 ipset 来存储需要 NAT 或 masquared 时的 ip 和端口列表。在数据包过滤过程中，首先遍历 iptables 规则，在定义了使用 ipset 的条件下会跳转到 ipset 列表中进行匹配。



### kube-proxy ipvs 模式

kube-proxy 的 ipvs 模式是在 2015 年由 k8s 社区的大佬 **[thockin](https://github.com/thockin)** 提出的([Try kube-proxy via ipvs instead of iptables or userspace](https://github.com/kubernetes/kubernetes/issues/17470))，在 2017 年由华为云团队实现的([Implement IPVS-based in-cluster service load balancing](https://github.com/kubernetes/kubernetes/issues/44063))。前面的文章已经提到了，在`kubernetes` v1.8 中已经引入了 ipvs 模式。



kube-proxy 在 ipvs 模式下自定义了八条链，分别为 KUBE-SERVICES、KUBE-FIREWALL、KUBE-POSTROUTING、KUBE-MARK-MASQ、KUBE-NODE-PORT、KUBE-MARK-DROP、KUBE-FORWARD、KUBE-LOAD-BALANCER ，如下所示：

NAT 表：

![](http://cdn.tianfeiyu.com/ipvs-2.png)



Filter 表：

![](http://cdn.tianfeiyu.com/ipvs-3.png)



此外，由于 linux 内核原生的 ipvs 模式只支持 DNAT，不支持 SNAT，所以，在以下几种场景中 ipvs 仍需要依赖 iptables 规则：

- 1、kube-proxy 启动时指定 `–-masquerade-all=true` 参数，即集群中所有经过 kube-proxy 的包都做一次 SNAT；
- 2、kube-proxy 启动时指定 `--cluster-cidr=` 参数；
- 3、对于 Load Balancer 类型的 service，用于配置白名单；
- 4、对于 NodePort 类型的 service，用于配置 MASQUERADE；
- 5、对于 externalIPs 类型的 service；

但对于 ipvs 模式的 kube-proxy，无论有多少 pod/service，iptables 的规则数都是固定的。



#### ipvs 模式的启用

1、首先要加载 IPVS 所需要的 kernel module

```
$ modprobe -- ip_vs
$ modprobe -- ip_vs_rr
$ modprobe -- ip_vs_wrr
$ modprobe -- ip_vs_sh
$ modprobe -- nf_conntrack_ipv4
$ cut -f1 -d " "  /proc/modules | grep -e ip_vs -e nf_conntrack_ipv4
```

2、在启动 kube-proxy 时，指定 proxy-mode 参数

```
--proxy-mode=ipvs
```

(如果要使用其他负载均衡算法，可以指定 `--ipvs-scheduler=` 参数，默认为 rr)



当创建 ClusterIP type 的 service 时，IPVS proxier 会执行以下三个操作：

- 确保本机已创建 dummy 网卡，默认为 kube-ipvs0。为什么要创建 dummy 网卡？因为 ipvs netfilter 的 DNAT 钩子挂载在 INPUT 链上，当访问 ClusterIP 时，将 ClusterIP 绑定在 dummy 网卡上为了让内核识别该 IP 就是本机 IP，进而进入 INPUT 链，然后通过钩子函数 ip_vs_in 转发到 POSTROUTING 链；
- 将 ClusterIP 绑定到 dummy 网卡；
- 为每个 ClusterIP 创建 IPVS virtual servers 和 real server，分别对应 service 和 endpoints；

例如下面的示例：

```
// kube-ipvs0 dummy 网卡
$ ip addr
......
4: kube-ipvs0: <BROADCAST,NOARP> mtu 1500 qdisc noop state DOWN group default
    link/ether de:be:c0:73:bc:c7 brd ff:ff:ff:ff:ff:ff
    inet 10.96.0.1/32 brd 10.96.0.1 scope global kube-ipvs0
       valid_lft forever preferred_lft forever
    inet 10.96.0.10/32 brd 10.96.0.10 scope global kube-ipvs0
       valid_lft forever preferred_lft forever
    inet 10.97.4.140/32 brd 10.97.4.140 scope global kube-ipvs0
       valid_lft forever preferred_lft forever
    ......


// 10.97.4.140 为 CLUSTER-IP 挂载在 kube-ipvs0 上
$ kubectl get svc
NAME             TYPE        CLUSTER-IP    EXTERNAL-IP   PORT(S)    AGE
tenant-service   ClusterIP   10.97.4.140   <none>        7000/TCP   23s

// 10.97.4.140 后端的 realserver 分别为 10.244.1.2 和 10.244.1.3
$ ipvsadm -L -n
IP Virtual Server version 1.2.1 (size=4096)
Prot LocalAddress:Port Scheduler Flags
  -> RemoteAddress:Port           Forward Weight ActiveConn InActConn
TCP  10.97.4.140:7000 rr
  -> 10.244.1.2:7000              Masq    1      0          0
  -> 10.244.1.3:7000              Masq    1      0          0
```



#### ipvs 模式下数据包的流向

#### clusterIP 访问方式

```
PREROUTING --> KUBE-SERVICES --> KUBE-CLUSTER-IP --> INPUT --> KUBE-FIREWALL --> POSTROUTING
```

- 首先进入 PREROUTING 链
- 从 PREROUTING 链会转到 KUBE-SERVICES 链，10.244.0.0/16 为 ClusterIP 网段
- 在 KUBE-SERVICES 链打标记
- 从 KUBE-SERVICES 链再进入到 KUBE-CLUSTER-IP 链
- KUBE-CLUSTER-IP 为 ipset 集合，在此处会进行 DNAT
- 然后会进入 INPUT 链
- 从 INPUT 链会转到 KUBE-FIREWALL 链，在此处检查标记
- 在 INPUT 链处，ipvs 的 LOCAL_IN Hook 发现此包在 ipvs 规则中则直接转发到 POSTROUTING 链



```
-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES

-A KUBE-SERVICES ! -s 10.244.0.0/16 -m comment --comment "Kubernetes service cluster ip + port for masquerade purpose" -m set --match-set KUBE-CLUSTER-IP dst,dst -j KUBE-MARK-MASQ

// 执行完 PREROUTING 规则,数据打上0x4000/0x4000的标记
-A KUBE-MARK-MASQ -j MARK --set-xmark 0x4000/0x4000

-A KUBE-SERVICES -m set --match-set KUBE-CLUSTER-IP dst,dst -j ACCEPT
```

KUBE-CLUSTER-IP 为 ipset 列表：

```
# ipset list | grep -A 20 KUBE-CLUSTER-IP
Name: KUBE-CLUSTER-IP
Type: hash:ip,port
Revision: 5
Header: family inet hashsize 1024 maxelem 65536
Size in memory: 352
References: 2
Members:
10.96.0.10,17:53
10.96.0.10,6:53
10.96.0.1,6:443
10.96.0.10,6:9153
```

然后会进入 INPUT：

```
-A INPUT -j KUBE-FIREWALL

-A KUBE-FIREWALL -m comment --comment "kubernetes firewall for dropping marked packets" -m mark --mark 0x8000/0x8000 -j DROP
```

如果进来的数据带有 0x8000/0x8000 标记则丢弃，若有 0x4000/0x4000 标记则正常执行：

```
-A POSTROUTING -m comment --comment "kubernetes postrouting rules" -j KUBE-POSTROUTING
-A KUBE-POSTROUTING -m comment --comment "kubernetes service traffic requiring SNAT" -m mark --mark 0x4000/0x4000 -j MASQUERADE
```



#### nodePort 方式

```
PREROUTING --> KUBE-SERVICES --> KUBE-NODE-PORT --> INPUT --> KUBE-FIREWALL --> POSTROUTING
```

- 首先进入 PREROUTING 链
- 从 PREROUTING 链会转到 KUBE-SERVICES 链
- 在 KUBE-SERVICES 链打标记
- 从 KUBE-SERVICES 链再进入到 KUBE-NODE-PORT 链
- KUBE-NODE-PORT 为 ipset 集合，在此处会进行 DNAT
- 然后会进入 INPUT 链
- 从 INPUT 链会转到 KUBE-FIREWALL 链，在此处检查标记
- 在 INPUT 链处，ipvs 的 LOCAL_IN Hook 发现此包在 ipvs 规则中则直接转发到 POSTROUTING 链

```
-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES

-A KUBE-SERVICES ! -s 10.244.0.0/16 -m comment --comment "Kubernetes service cluster ip + port for masquerade purpose" -m set --match-set KUBE-CLUSTER-IP dst,dst -j KUBE-MARK-MASQ

-A KUBE-MARK-MASQ -j MARK --set-xmark 0x4000/0x4000

-A KUBE-SERVICES -m addrtype --dst-type LOCAL -j KUBE-NODE-PORT
```

KUBE-NODE-PORT 对应的 ipset 列表：

```
# ipset list | grep -B 10 KUBE-NODE-PORT
Name: KUBE-NODE-PORT-TCP
Type: bitmap:port
Revision: 3
Header: range 0-65535
Size in memory: 8268
References: 0
Members:

```

流入 INPUT 后与 ClusterIP 的访问方式相同。



### kube-proxy ipvs 源码分析

>  kubernetes 版本：v1.16

在前面的文章中已经介绍过 ipvs 的初始化了，下面直接看其核心方法：proxier.syncRunner。

```
func NewProxier(......) {
	......
 	proxier.syncRunner = async.NewBoundedFrequencyRunner("sync-runner", proxier.syncProxyRules, minSyncPeriod, syncPeriod, burstSyncs)
 	......
}
```



`proxier.syncRunner()` 执行流程：

- 通过 iptables-save 获取现有的 Filter 和 NAT 表存在的链数据
- 创建自定义链与规则
- 创建 Dummy 接口和 ipset 默认列表
- 为每个服务生成 ipvs 规则
- 对 serviceMap 内的每个服务进行遍历处理，对不同的服务类型(clusterip/nodePort/externalIPs/load-balancer)进行不同的处理(ipset 列表/vip/ipvs 后端服务器)
- 根据 endpoint 列表，更新 KUBE-LOOP-BACK 的 ipset 列表
- 若为 clusterIP 类型更新对应的 ipset 列表 KUBE-CLUSTER-IP
- 若为 externalIPs 类型更新对应的 ipset 列表 KUBE-EXTERNAL-IP
- 若为 load-balancer 类型更新对应的 ipset 列表 KUBE-LOAD-BALANCER、KUBE-LOAD-BALANCER-LOCAL、KUBE-LOAD-BALANCER-FW、KUBE-LOAD-BALANCER-SOURCE-CIDR、KUBE-LOAD-BALANCER-SOURCE-IP
- 若为 NodePort 类型更新对应的 ipset 列表 KUBE-NODE-PORT-TCP、KUBE-NODE-PORT-LOCAL-TCP、KUBE-NODE-PORT-LOCAL-SCTP-HASH、KUBE-NODE-PORT-LOCAL-UDP、KUBE-NODE-PORT-SCTP-HASH、KUBE-NODE-PORT-UDP
- 同步 ipset 记录
- 刷新 iptables 规则



```
func (proxier *Proxier) syncProxyRules() {
    proxier.mu.Lock()
    defer proxier.mu.Unlock()


    serviceUpdateResult := proxy.UpdateServiceMap(proxier.serviceMap, proxier.serviceChanges)
    endpointUpdateResult := proxier.endpointsMap.Update(proxier.endpointsChanges)

    staleServices := serviceUpdateResult.UDPStaleClusterIP
	// 合并 service 列表
    for _, svcPortName := range endpointUpdateResult.StaleServiceNames {
        if svcInfo, ok := proxier.serviceMap[svcPortName]; ok && svcInfo != nil && svcInfo.Protocol() == v1.ProtocolUDP {
            staleServices.Insert(svcInfo.ClusterIP().String())
            for _, extIP := range svcInfo.ExternalIPStrings() {
                staleServices.Insert(extIP)
            }
        }
    }
    ......
```

读取系统 iptables 到内存，创建自定义链以及 iptables 规则，创建 dummy interface kube-ipvs0，创建默认的 ipset 规则。

```
    proxier.natChains.Reset()
    proxier.natRules.Reset()
    proxier.filterChains.Reset()
    proxier.filterRules.Reset()

    writeLine(proxier.filterChains, "*filter")
    writeLine(proxier.natChains, "*nat")

	  // 创建kubernetes的表连接链数据
    proxier.createAndLinkeKubeChain()

		// 创建 dummy interface kube-ipvs0
    _, err := proxier.netlinkHandle.EnsureDummyDevice(DefaultDummyDevice)
    if err != nil {
    	......
        return
    }

		// 创建默认的 ipset 规则
    for _, set := range proxier.ipsetList {
        if err := ensureIPSet(set); err != nil {
            return
        }
        set.resetEntries()
    }
```



 对每一个服务创建 ipvs 规则。根据 endpoint 列表，更新 KUBE-LOOP-BACK 的 ipset 列表。

```
    for svcName, svc := range proxier.serviceMap {
        svcInfo, ok := svc.(*serviceInfo)
        if !ok {
            ......
        }

        for _, e := range proxier.endpointsMap[svcName] {
            ep, ok := e.(*proxy.BaseEndpointInfo)
            if !ok {
                klog.Errorf("Failed to cast BaseEndpointInfo %q", e.String())
                continue
            }
            ......

            if valid := proxier.ipsetList[kubeLoopBackIPSet].validateEntry(entry); !valid {
                ......
            }
            proxier.ipsetList[kubeLoopBackIPSet].activeEntries.Insert(entry.String())
        }
```

对于 clusterIP 类型更新对应的 ipset 列表 KUBE-CLUSTER-IP。

```
        if valid := proxier.ipsetList[kubeClusterIPSet].validateEntry(entry); !valid {
            ......
        }
        proxier.ipsetList[kubeClusterIPSet].activeEntries.Insert(entry.String())
        ......
        if svcInfo.SessionAffinityType() == v1.ServiceAffinityClientIP {
            ......
        }
        // 绑定 ClusterIP to dummy interface
        if err := proxier.syncService(svcNameString, serv, true); err == nil {
        	// 同步 endpoints 信息
            if err := proxier.syncEndpoint(svcName, false, serv); err != nil {
                ......
            }
        } else {
            ......
        }
```

为 externalIP 创建 ipvs 规则。

```
        for _, externalIP := range svcInfo.ExternalIPStrings() {
            if local, err := utilproxy.IsLocalIP(externalIP); err != nil {
                ......
            } else if local && (svcInfo.Protocol() != v1.ProtocolSCTP) {
                ......
                if proxier.portsMap[lp] != nil {
                    ......
                } else {
                    socket, err := proxier.portMapper.OpenLocalPort(&lp)
                    if err != nil {
                        ......
                    }
                    replacementPortsMap[lp] = socket
                }
            }
            ......
            if valid := proxier.ipsetList[kubeExternalIPSet].validateEntry(entry); !valid {
                ......
            }
            proxier.ipsetList[kubeExternalIPSet].activeEntries.Insert(entry.String())

            ......
            if svcInfo.SessionAffinityType() == v1.ServiceAffinityClientIP {
                ......
            }
            if err := proxier.syncService(svcNameString, serv, true); err == nil {
                ......
                if err := proxier.syncEndpoint(svcName, false, serv); err != nil {
                    ......
                }
            } else {
                ......
            }
        }
```

为 load-balancer类型创建 ipvs 规则。

```
        for _, ingress := range svcInfo.LoadBalancerIPStrings() {
            if ingress != "" {
                ......
                if valid := proxier.ipsetList[kubeLoadBalancerSet].validateEntry(entry); !valid {
                    ......
                }
                proxier.ipsetList[kubeLoadBalancerSet].activeEntries.Insert(entry.String())

                if svcInfo.OnlyNodeLocalEndpoints() {
                    ......
                }
                if len(svcInfo.LoadBalancerSourceRanges()) != 0 {
                    ......
                    for _, src := range svcInfo.LoadBalancerSourceRanges() {
                      	......
                    }
                    ......
                }
                ......
                if svcInfo.SessionAffinityType() == v1.ServiceAffinityClientIP {
                    ......
                }
                if err := proxier.syncService(svcNameString, serv, true); err == nil {
                    ......
                    if err := proxier.syncEndpoint(svcName, svcInfo.OnlyNodeLocalEndpoints(), serv); err != nil {
                       ......
                    }
                } else {
                    ......
                }
            }
        }
```

为 nodePort 类型创建 ipvs 规则。

```
        if svcInfo.NodePort() != 0 {
            ......

            var lps []utilproxy.LocalPort
            for _, address := range nodeAddresses {
                ......
                lps = append(lps, lp)
            }
            for _, lp := range lps {
                if proxier.portsMap[lp] != nil {
                    ......
                } else if svcInfo.Protocol() != v1.ProtocolSCTP {
                    socket, err := proxier.portMapper.OpenLocalPort(&lp)
                    if err != nil {
                        ......
                    }
                    if lp.Protocol == "udp" {
                        ......
                    }
                }
            }
            switch protocol {
            case "tcp":
                    ......
            case "udp":
                    ......
            case "sctp":
                    ......
            default:
                    ......
            }
            if nodePortSet != nil {
                for _, entry := range entries {
                    ......
                    nodePortSet.activeEntries.Insert(entry.String())
                }
            }

            if svcInfo.OnlyNodeLocalEndpoints() {
                var nodePortLocalSet *IPSet
                switch protocol {
                case "tcp":
                    nodePortLocalSet = proxier.ipsetList[kubeNodePortLocalSetTCP]
                case "udp":
                    nodePortLocalSet = proxier.ipsetList[kubeNodePortLocalSetUDP]
                case "sctp":
                    nodePortLocalSet = proxier.ipsetList[kubeNodePortLocalSetSCTP]
                default:
                    ......
                }
                if nodePortLocalSet != nil {
                    entryInvalidErr := false
                    for _, entry := range entries {
												......
                        nodePortLocalSet.activeEntries.Insert(entry.String())
                    }
                    ......
                }
            }
            for _, nodeIP := range nodeIPs {
					......
                if svcInfo.SessionAffinityType() == v1.ServiceAffinityClientIP {
                    ......
                }
                if err := proxier.syncService(svcNameString, serv, false); err == nil {
                    if err := proxier.syncEndpoint(svcName, svcInfo.OnlyNodeLocalEndpoints(), serv); err != nil {
                        ......
                    }
                } else {
                    ......
                }
            }
        }
    }
```

同步 ipset 记录，清理 conntrack。

```
    for _, set := range proxier.ipsetList {
        set.syncIPSetEntries()
    }

    proxier.writeIptablesRules()

    proxier.iptablesData.Reset()
    proxier.iptablesData.Write(proxier.natChains.Bytes())
    proxier.iptablesData.Write(proxier.natRules.Bytes())
    proxier.iptablesData.Write(proxier.filterChains.Bytes())
    proxier.iptablesData.Write(proxier.filterRules.Bytes())

    err = proxier.iptables.RestoreAll(proxier.iptablesData.Bytes(), utiliptables.NoFlushTables, utiliptables.RestoreCounters)
    if err != nil {
        ......
    }
    ......
    proxier.deleteEndpointConnections(endpointUpdateResult.StaleEndpoints)
}
```



### 总结

本文主要讲述了 kube-proxy ipvs 模式的原理与实现，iptables 模式与 ipvs 模式下在源码实现上有许多相似之处，但二者原理不同，理解了原理分析代码则更加容易，笔者对于 ipvs 的知识也是现学的，文中如有不当之处望指正。虽然 ipvs 的性能要比 iptables 更好，但社区中已有相关的文章指出  [BPF(Berkeley Packet Filter)](https://lwn.net/Articles/747551/) 比 ipvs 的性能更好，且 BPF 将要取代 iptables，至于下一步如何发展，让我们拭目以待。



参考：

http://www.austintek.com/LVS/LVS-HOWTO/HOWTO/LVS-HOWTO.filter_rules.html

https://bestsamina.github.io/posts/2018-10-19-ipvs-based-kube-proxy-4-scaled-k8s-lb/

https://www.bookstack.cn/read/k8s-source-code-analysis/core-kube-proxy-ipvs.md

https://blog.51cto.com/goome/2369150

https://xigang.github.io/2019/07/21/kubernetes-service/

https://segmentfault.com/a/1190000016333317

https://cilium.io/blog/2018/04/17/why-is-the-kernel-community-replacing-iptables/


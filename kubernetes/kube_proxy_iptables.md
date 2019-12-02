---
title: kube-proxy iptables 模式源码分析
date: 2019-11-6 19:50:30
tags: ["kube-proxy","iptables"]
type: "kube-proxy"

---

### iptables 的功能

在前面的文章中已经介绍过  iptable 的一些基本信息，本文会深入介绍 kube-proxy iptables 模式下的工作原理，本文中多处会与 iptables 的知识相关联，若没有 iptables 基础，请先自行补充。

iptables 的功能：
- 流量转发：DNAT 实现 IP 地址和端口的映射；
- 负载均衡：statistic 模块为每个后端设置权重；
- 会话保持：recent 模块设置会话保持时间；

iptables 有五张表和五条链，五条链分别对应为：
- PREROUTING 链：数据包进入路由之前，可以在此处进行 DNAT；
- INPUT 链：一般处理本地进程的数据包，目的地址为本机；
- FORWARD 链：一般处理转发到其他机器或者 network namespace 的数据包；
- OUTPUT 链：原地址为本机，向外发送，一般处理本地进程的输出数据包；
- POSTROUTING 链：发送到网卡之前，可以在此处进行 SNAT；

五张表分别为：
- filter 表：用于控制到达某条链上的数据包是继续放行、直接丢弃(drop)还是拒绝(reject)；
- nat 表：network address translation 网络地址转换，用于修改数据包的源地址和目的地址；
- mangle 表：用于修改数据包的 IP 头信息；
- raw 表：iptables 是有状态的，其对数据包有链接追踪机制，连接追踪信息在 /proc/net/nf_conntrack 中可以看到记录，而 raw 是用来去除链接追踪机制的；
- security 表：最不常用的表，用在 SELinux 上；

这五张表是对 iptables 所有规则的逻辑集群且是有顺序的，当数据包到达某一条链时会按表的顺序进行处理，表的优先级为：raw、mangle、nat、filter、security。



iptables 的工作流程如下图所示：

![iptables](http://cdn.tianfeiyu.com/FW-IDS-iptables-Flowchart-v2019-04-30-1.png)



### kube-proxy 的 iptables 模式

kube-proxy 组件负责维护 node 节点上的防火墙规则和路由规则，在 iptables 模式下，会根据 service 以及 endpoints 对象的改变来实时刷新规则，kube-proxy 使用了 iptables 的 filter 表和 nat 表，并对 iptables 的链进行了扩充，自定义了 KUBE-SERVICES、KUBE-EXTERNAL-SERVICES、KUBE-NODEPORTS、KUBE-POSTROUTING、KUBE-MARK-MASQ、KUBE-MARK-DROP、KUBE-FORWARD 七条链，另外还新增了以“KUBE-SVC-xxx”和“KUBE-SEP-xxx”开头的数个链，除了创建自定义的链以外还将自定义链插入到已有链的后面以便劫持数据包。



 在 nat 表中自定义的链以及追加的链如下所示：

![](http://cdn.tianfeiyu.com/image-20191106155056092.png)



在 filter 表定义的链以及追加的链如下所示如下所示：

![](http://cdn.tianfeiyu.com/image-20191106154640930.png)



对于 KUBE-MARK-MASQ 链中所有规则设置了 kubernetes 独有的 MARK 标记，在 KUBE-POSTROUTING 链中对 node 节点上匹配 kubernetes 独有 MARK 标记的数据包，进行 SNAT 处理。

```
-A KUBE-MARK-MASQ -j MARK --set-xmark 0x4000/0x4000
```


Kube-proxy 接着为每个服务创建 KUBE-SVC-xxx 链，并在 nat 表中将 KUBE-SERVICES 链中每个目标地址是service 的数据包导入这个 KUBE-SVC-xxx 链，如果 endpoint 尚未创建，则 KUBE-SVC-xxx 链中没有规则，任何 incomming packets 在规则匹配失败后会被 KUBE-MARK-DROP 进行标记然后再 FORWARD 链中丢弃。

这些自定义链与 iptables 的表结合后如下所示，笔者只画出了 PREROUTING 和 OUTPUT 链中追加的链以及部分自定义链，因为 PREROUTING 和 OUTPUT 的首条 NAT 规则都先将所有流量导入KUBE-SERVICE 链中，这样就截获了所有的入流量和出流量，进而可以对 k8s 相关流量进行重定向处理。

![](http://cdn.tianfeiyu.com/image-20191106150202161.png)



kubernetes 自定义链中数据包的详细流转可以参考：

![](http://cdn.tianfeiyu.com/Center.png)



### iptables 规则分析

#### clusterIP 访问方式

创建一个 clusterIP 访问方式的 service 以及带有两个副本，从 pod 中访问 clusterIP 的 iptables 规则流向为：

```
PREROUTING --> KUBE-SERVICE --> KUBE-SVC-XXX --> KUBE-SEP-XXX
```

访问流程如下所示：

- 1、对于进入 PREROUTING 链的都转到 KUBE-SERVICES 链进行处理；
- 2、在 KUBE-SERVICES 链，对于访问 clusterIP 为 10.110.243.155 的转发到 KUBE-SVC-5SB6FTEHND4GTL2W； 
- 3、访问 KUBE-SVC-5SB6FTEHND4GTL2W 的使用随机数负载均衡，并转发到 KUBE-SEP-CI5ZO3FTK7KBNRMG 和 KUBE-SEP-OVNLTDWFHTHII4SC 上；
- 4、KUBE-SEP-CI5ZO3FTK7KBNRMG 和 KUBE-SEP-OVNLTDWFHTHII4SC 对应 endpoint 中的 pod 192.168.137.147 和 192.168.98.213，设置 mark 标记，进行 DNAT 并转发到具体的 pod 上，如果某个 service 的 endpoints 中没有 pod，那么针对此 service 的请求将会被 drop 掉；

```
// 1.
-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES

// 2.
-A KUBE-SERVICES -d 10.110.243.155/32 -p tcp -m comment --comment "pks-system/tenant-service: cluster IP" -m tcp --dport 7000 -j KUBE-SVC-5SB6FTEHND4GTL2W

// 3.
-A KUBE-SVC-5SB6FTEHND4GTL2W -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-CI5ZO3FTK7KBNRMG
-A KUBE-SVC-5SB6FTEHND4GTL2W -j KUBE-SEP-OVNLTDWFHTHII4SC


// 4.
-A KUBE-SEP-CI5ZO3FTK7KBNRMG -s 192.168.137.147/32 -j KUBE-MARK-MASQ
-A KUBE-SEP-CI5ZO3FTK7KBNRMG -p tcp -m tcp -j DNAT --to-destination 192.168.137.147:7000

-A KUBE-SEP-OVNLTDWFHTHII4SC -s 192.168.98.213/32 -j KUBE-MARK-MASQ
-A KUBE-SEP-OVNLTDWFHTHII4SC -p tcp -m tcp -j DNAT --to-destination 192.168.98.213:7000
```



#### nodePort 方式

在 nodePort 方式下，会用到 KUBE-NODEPORTS 规则链，通过 `iptables -t nat -L -n` 可以看到 KUBE-NODEPORTS 位于 KUBE-SERVICE 链的最后一个，iptables 在处理报文时会优先处理目的 IP 为clusterIP 的报文，在前面的 KUBE-SVC-XXX 都匹配失败之后再去使用 nodePort 方式进行匹配。



创建一个 nodePort 访问方式的 service 以及带有两个副本，访问 nodeport 的 iptables 规则流向为：

1、非本机访问

```
PREROUTING --> KUBE-SERVICE --> KUBE-NODEPORTS --> KUBE-SVC-XXX --> KUBE-SEP-XXX
```

2、本机访问

```
OUTPUT --> KUBE-SERVICE --> KUBE-NODEPORTS --> KUBE-SVC-XXX --> KUBE-SEP-XXX
```

该服务的 nodePort 端口为 30070，其 iptables 访问规则和使用 clusterIP 方式访问有点类似，不过 nodePort 方式会比 clusterIP 的方式多走一条链 KUBE-NODEPORTS，其会在 KUBE-NODEPORTS 链设置 mark 标记并转发到 KUBE-SVC-5SB6FTEHND4GTL2W，nodeport 与 clusterIP 访问方式最后都是转发到了 KUBE-SVC-xxx 链。

- 1、经过 PREROUTING 转到 KUBE-SERVICES
- 2、经过 KUBE-SERVICES 转到 KUBE-NODEPORTS
- 3、经过 KUBE-NODEPORTS 转到 KUBE-SVC-5SB6FTEHND4GTL2W
- 4、经过 KUBE-SVC-5SB6FTEHND4GTL2W 转到 KUBE-SEP-CI5ZO3FTK7KBNRMG 和 KUBE-SEP-VR562QDKF524UNPV
- 5、经过 KUBE-SEP-CI5ZO3FTK7KBNRMG 和 KUBE-SEP-VR562QDKF524UNPV 分别转到 192.168.137.147:7000 和 192.168.89.11:7000

```
// 1.
-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES

// 2.
......
-A KUBE-SERVICES xxx
......
-A KUBE-SERVICES -m comment --comment "kubernetes service nodeports; NOTE: this must be the last rule in this chain" -m addrtype --dst-type LOCAL -j KUBE-NODEPORTS

// 3.
-A KUBE-NODEPORTS -p tcp -m comment --comment "pks-system/tenant-service:" -m tcp --dport 30070 -j KUBE-MARK-MASQ
-A KUBE-NODEPORTS -p tcp -m comment --comment "pks-system/tenant-service:" -m tcp --dport 30070 -j KUBE-SVC-5SB6FTEHND4GTL2W

// 4、
-A KUBE-SVC-5SB6FTEHND4GTL2W -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-CI5ZO3FTK7KBNRMG
-A KUBE-SVC-5SB6FTEHND4GTL2W -j KUBE-SEP-VR562QDKF524UNPV

// 5、
-A KUBE-SEP-CI5ZO3FTK7KBNRMG -s 192.168.137.147/32 -j KUBE-MARK-MASQ
-A KUBE-SEP-CI5ZO3FTK7KBNRMG -p tcp -m tcp -j DNAT --to-destination 192.168.137.147:7000
-A KUBE-SEP-VR562QDKF524UNPV -s 192.168.89.11/32 -j KUBE-MARK-MASQ
-A KUBE-SEP-VR562QDKF524UNPV -p tcp -m tcp -j DNAT --to-destination 192.168.89.11:7000
```

其他访问方式对应的 iptables 规则可自行分析。



### iptables 模式源码分析

> kubernetes 版本：v1.16 

上篇文章已经在源码方面做了许多铺垫，下面就直接看 kube-proxy iptables 模式的核心方法。首先回顾一下 iptables 模式的调用流程，kube-proxy 根据给定的 proxyMode 初始化对应的 proxier 后会调用 `Proxier.SyncLoop()` 执行 proxier 的主循环，而其最终会调用 `proxier.syncProxyRules()` 刷新 iptables 规则。

```
proxier.SyncLoop() --> proxier.syncRunner.Loop()-->bfr.tryRun()-->bfr.fn()-->proxier.syncProxyRules()
```

`proxier.syncProxyRules()`这个函数比较长，大约 800 行，其中有许多冗余的代码，代码可读性不佳，我们只需理解其基本流程即可，该函数的主要功能为：

- 更新proxier.endpointsMap，proxier.servieMap
- 创建自定义链
- 将当前内核中 filter 表和 nat 表中的全部规则导入到内存中
- 为每个 service 创建规则
- 为 clusterIP 设置访问规则
- 为 externalIP 设置访问规则
- 为 ingress 设置访问规则
- 为 nodePort 设置访问规则
- 为 endpoint 生成规则链
- 写入 DNAT 规则
- 删除不再使用的服务自定义链
- 使用 iptables-restore 同步规则



首先是更新 proxier.endpointsMap，proxier.servieMap 两个对象。

`k8s.io/kubernetes/pkg/proxy/iptables/proxier.go:677`

```
func (proxier *Proxier) syncProxyRules() {
	......
    serviceUpdateResult := proxy.UpdateServiceMap(proxier.serviceMap, proxier.serviceChanges)
    endpointUpdateResult := proxier.endpointsMap.Update(proxier.endpointsChanges)

    staleServices := serviceUpdateResult.UDPStaleClusterIP
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

然后创建所需要的 iptable 链：

```
    for _, jump := range iptablesJumpChains {
    	  // 创建自定义链
        if _, err := proxier.iptables.EnsureChain(jump.table, jump.dstChain); err != nil {
            .....
        }
        args := append(jump.extraArgs,
            ......
        )
        //插入到已有的链
        if _, err := proxier.iptables.EnsureRule(utiliptables.Prepend, jump.table, jump.srcChain, args...); err != nil {
            ......
        }
    }
```

将当前内核中 filter 表和 nat 表中的全部规则临时导出到 buffer 中：

```
	err := proxier.iptables.SaveInto(utiliptables.TableFilter, proxier.existingFilterChainsData)
	if err != nil { 

	} else { 
		existingFilterChains = utiliptables.GetChainLines(utiliptables.TableFilter, proxier.existingFilterChainsData.Bytes())
	}
	
    ......
	err = proxier.iptables.SaveInto(utiliptables.TableNAT, proxier.iptablesData)
	if err != nil { 
	
	} else { 
		existingNATChains = utiliptables.GetChainLines(utiliptables.TableNAT, proxier.iptablesData.Bytes())
	}

	writeLine(proxier.filterChains, "*filter")
	writeLine(proxier.natChains, "*nat")
```

检查已经创建出的表是否存在：

```
	for _, chainName := range []utiliptables.Chain{kubeServicesChain, kubeExternalServicesChain, kubeForwardChain} {
		if chain, ok := existingFilterChains[chainName]; ok {
			writeBytesLine(proxier.filterChains, chain)
		} else {
			writeLine(proxier.filterChains, utiliptables.MakeChainLine(chainName))
		}
	}
	for _, chainName := range []utiliptables.Chain{kubeServicesChain, kubeNodePortsChain, kubePostroutingChain, KubeMarkMasqChain} {
		if chain, ok := existingNATChains[chainName]; ok {
			writeBytesLine(proxier.natChains, chain)
		} else {
			writeLine(proxier.natChains, utiliptables.MakeChainLine(chainName))
		}
	}
```

写入 SNAT 地址伪装规则，在 POSTROUTING 阶段对地址进行 MASQUERADE 处理，原始请求源 IP 将被丢失，被请求 pod 的应用看到为 NodeIP 或 CNI 设备 IP(bridge/vxlan设备)：

```
    masqRule := []string{
        ......
    }
    if proxier.iptables.HasRandomFully() {
        masqRule = append(masqRule, "--random-fully")
    } else {

    }
    writeLine(proxier.natRules, masqRule...)

    writeLine(proxier.natRules, []string{
        ......
    }...)
```

为每个 service 创建规则，创建 KUBE-SVC-xxx 和 KUBE-XLB-xxx 链、创建 service portal 规则、为 clusterIP 创建规则：

```
    for svcName, svc := range proxier.serviceMap {
        svcInfo, ok := svc.(*serviceInfo)
        
        ......
        if hasEndpoints {
            ......
        }

        svcXlbChain := svcInfo.serviceLBChainName
        if svcInfo.OnlyNodeLocalEndpoints() {
            ......
        }

        if hasEndpoints {
            ......
        } else {
            ......
        }
```

若服务使用了 externalIP，创建对应的规则：

```
        for _, externalIP := range svcInfo.ExternalIPStrings() {
            if local, err := utilproxy.IsLocalIP(externalIP); err != nil {
                ......
                if proxier.portsMap[lp] != nil {
                    ......
                } else {
                    ......
                }
            }
            if hasEndpoints {
                ......
            } else {
                ......
            }
        }
```

若服务使用了 ingress，创建对应的规则：

```
        for _, ingress := range svcInfo.LoadBalancerIPStrings() {
            if ingress != "" {
                if hasEndpoints {
                    ......
                    if !svcInfo.OnlyNodeLocalEndpoints() {
                        ......
                    }

                    if len(svcInfo.LoadBalancerSourceRanges()) == 0 {
                        ......
                    } else {
                        ......
                    }
                    ......

                } else {
                    ......
                }
            }
        }
```

若使用了 nodePort，创建对应的规则：

```
        if svcInfo.NodePort() != 0 {
            addresses, err := utilproxy.GetNodeAddresses(proxier.nodePortAddresses, proxier.networkInterfacer)

            lps := make([]utilproxy.LocalPort, 0)
            for address := range addresses {
                ......
                lps = append(lps, lp)
            }

            for _, lp := range lps {
                if proxier.portsMap[lp] != nil {

                } else if svcInfo.Protocol() != v1.ProtocolSCTP {
                    socket, err := proxier.portMapper.OpenLocalPort(&lp)
                    ......
                    if lp.Protocol == "udp" {
                        ......
                    }
                    replacementPortsMap[lp] = socket
                }
            }
            if hasEndpoints {
                ......
            } else {
                ......
            }
        }
```

为 endpoint 生成规则链 KUBE-SEP-XXX：

```
        endpoints = endpoints[:0]
        endpointChains = endpointChains[:0]
        var endpointChain utiliptables.Chain
        for _, ep := range proxier.endpointsMap[svcName] {
            epInfo, ok := ep.(*endpointsInfo)
            ......
            if chain, ok := existingNATChains[utiliptables.Chain(endpointChain)]; ok {
                writeBytesLine(proxier.natChains, chain)
            } else {
                writeLine(proxier.natChains, utiliptables.MakeChainLine(endpointChain))
            }
            activeNATChains[endpointChain] = true
        }
```

如果创建 service 时指定了 SessionAffinity 为 clientIP 则使用 recent 创建保持会话连接的规则：

```
        if svcInfo.SessionAffinityType() == v1.ServiceAffinityClientIP {
            for _, endpointChain := range endpointChains {
                ......
            }
        }
```

写入负载均衡和 DNAT 规则，对于 endpoints 中的 pod 使用随机访问负载均衡策略。
- 在 iptables 规则中加入该 service 对应的自定义链“KUBE-SVC-xxx”，如果该服务对应的 endpoints 大于等于2，则添加负载均衡规则；
- 针对非本地 Node 上的 pod，需进行 DNAT，将请求的目标地址设置成候选的 pod 的 IP 后进行路由，KUBE-MARK-MASQ 将重设(伪装)源地址；

```
        for i, endpointChain := range endpointChains {
            ......
            if svcInfo.OnlyNodeLocalEndpoints() && endpoints[i].IsLocal {
                ......
            }
            ......
            epIP := endpoints[i].IP()
            if epIP == "" {
                ......
            }
            ......
            args = append(args, "-j", string(endpointChain))
            writeLine(proxier.natRules, args...)

            ......
            if svcInfo.SessionAffinityType() == v1.ServiceAffinityClientIP {
                ......
            }
            ......
            writeLine(proxier.natRules, args...)
        }
```

若启用了 clusterCIDR 则生成对应的规则链：

```
        if len(proxier.clusterCIDR) > 0 {
            ......
            writeLine(proxier.natRules, args...)
        }
```

为本机的 pod 开启会话保持：

```
        args = append(args[:0], "-A", string(svcXlbChain))
        writeLine(proxier.natRules, ......)

        numLocalEndpoints := len(localEndpointChains)
        if numLocalEndpoints == 0 {
            ......
            writeLine(proxier.natRules, args...)
        } else {
            if svcInfo.SessionAffinityType() == v1.ServiceAffinityClientIP {
                for _, endpointChain := range localEndpointChains {
                    ......
                }
            }
            ......
            for i, endpointChain := range localEndpointChains {
                ......
                args = append(args, "-j", string(endpointChain))
                writeLine(proxier.natRules, args...)
            }
        }
    }
```

删除不存在服务的自定义链，KUBE-SVC-xxx、KUBE-SEP-xxx、KUBE-FW-xxx、KUBE-XLB-xxx：

```
    for chain := range existingNATChains {
        if !activeNATChains[chain] {
            ......
            if !strings.HasPrefix(chainString, "KUBE-SVC-") && !strings.HasPrefix(chainString, "KUBE-SEP-") && !strings.HasPrefix(chainString, "KUBE-FW-") && !      strings.HasPrefix(chainString, "KUBE-XLB-") {
                ......
                continue
            }

            writeBytesLine(proxier.natChains, existingNATChains[chain])
            writeLine(proxier.natRules, "-X", chainString)
        }
    }
```

在 KUBE-SERVICES 链最后添加 nodePort 规则：

```
    addresses, err := utilproxy.GetNodeAddresses(proxier.nodePortAddresses, proxier.networkInterfacer)
    if err != nil {
            ......
    } else {
        for address := range addresses {
            if utilproxy.IsZeroCIDR(address) {
                ......
            }
            if isIPv6 && !utilnet.IsIPv6String(address) || !isIPv6 && utilnet.IsIPv6String(address) {
                ......
            }
            .....
            writeLine(proxier.natRules, args...)
        }
    }
```

为 INVALID 状态的包添加规则，为 KUBE-FORWARD 链添加对应的规则：

```
    writeLine(proxier.filterRules,
        ......
    )
    
    writeLine(proxier.filterRules,
        ......
    )
    
    if len(proxier.clusterCIDR) != 0 {
        writeLine(proxier.filterRules,
            ......
        )
        writeLine(proxier.filterRules,
            ......
        )
    }
```

在结尾添加标志：

```
    writeLine(proxier.filterRules, "COMMIT")
    writeLine(proxier.natRules, "COMMIT")
```

使用 iptables-restore 同步规则：

```
    proxier.iptablesData.Reset()
    proxier.iptablesData.Write(proxier.filterChains.Bytes())
    proxier.iptablesData.Write(proxier.filterRules.Bytes())
    proxier.iptablesData.Write(proxier.natChains.Bytes())
    proxier.iptablesData.Write(proxier.natRules.Bytes())

    err = proxier.iptables.RestoreAll(proxier.iptablesData.Bytes(), utiliptables.NoFlushTables, utiliptables.RestoreCounters)
    if err != nil {
        ......
    }
```

以上就是对 kube-proxy iptables 代理模式核心源码的一个走读。



### 总结

本文主要讲了 kube-proxy  iptables 模式的实现，可以看到其中的 iptables 规则是相当复杂的，在实际环境中尽量根据已有服务再来梳理整个 iptables 规则链就比较清楚了，笔者对于 iptables 的知识也是现学的，文中如有不当之处望指正。上面分析完了整个 iptables 模式的功能，但是 iptable 存在一些性能问题，比如有规则线性匹配时延、规则更新时延、可扩展性差等，为了解决这些问题于是有了 ipvs 模式，在下篇文章中会继续介绍 ipvs 模式的实现。



参考：

https://www.jianshu.com/p/a978af8e5dd8

https://blog.csdn.net/ebay/article/details/52798074

https://blog.csdn.net/horsefoot/article/details/51249161

https://rootdeep.github.io/posts/kube-proxy-code-analysis/

https://www.cnblogs.com/charlieroro/p/9588019.html



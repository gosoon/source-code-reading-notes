---
title: blkio cgroup
date: 2021-01-01 20:50:30
tags: ["blkio cgroup","cgroup v1"]
type: "blkio cgroup"

---

         * [blkio cgroup 基本功能](#blkio-cgroup-基本功能)
         * [Linux 写文件流程](#linux-写文件流程)
         * [为什么 cgroup v1 不支持非 Buffer IO 的限制](#为什么-cgroup-v1-不支持非-buffer-io-的限制)

### blkio cgroup 基本功能

blkio 是 cgroup v1 中的一个子系统，使用 cgroup v1 blkio 子系统主要是为了减少进程之间共同读写同一块磁盘时相互干扰的问题。

cgroup v1 blkio 控制子系统可以限制进程读写的 IOPS 和吞吐量，但它只能对 Direct I/O 的文件读写进行限速，对 Buffered I/O 的文件读写无法限制。

Buffered I/O 指会经过 PageCache 然后再写入到存储设备中。这里面的 Buffered 的含义跟内存中 buffer cache 不同，这里的 Buffered 含义相当于内存中的buffer cache+page cache。



在 blkio cgroup 中，主要有以下四个参数来限制磁盘 I/O：

```
blkio.throttle.read_bps_device
blkio.throttle.read_iops_device
blkio.throttle.write_bps_device
blkio.throttle.write_iops_device
```

如果要限制某个控制组对磁盘的写入吞吐量不超过 10M/s，我们可以对blkio.throttle.write_bps_device参数进行配置：

```
echo "8:0 10485760" > /sys/fs/cgroup/blkio/blkio.throttle.write_bps_device
```

在 Linux 中，文件默认读写方式为 Buffered I/O，应用程序一般将文件写入到 PageCache 后就直接返回了，然后内核线程会异步将数据从内存同步到磁盘中。而 Direct I/O 不会和内存打交道，而是直接写入到存储设备中。

要了解 blkio cgroup 的限速逻辑，需要先了解下 Linux 的写文件流程。

### Linux 写文件流程

![linux-io-process](https://cdn.tianfeiyu.com/linux-io-process.png)



上图是 Linux 写文件的一个流程图，图中主要包含三块，用户层、内核层、硬件层，Linux 在写文件时要经过系统调用、VFS、PageCache、文件系统、通用块管理层、IO调度层等多个流程后最终会将文件写入到磁盘中。而 blkio cgroup 作用在通用块管理层。Buffered I/O 是先写入到 PageCache 再走后面的流程将数据写入磁盘，而 Direct I/O 会绕过 PageCache 直接走后面的流程。

Linux 中应用程序对文件读写时默认是以 Buffered I/O 的形式写入的，此时并不需要经过通用块管理层，只需写入到 PageCache 即可，所以无法被限速，但 PageCache 中的数据总是要经过通用块管理层写入到磁盘的，原则上说也有影响，但是对于应用程序来说感受可能不一样，这与 PageCache 写入磁盘的机制也有关系。

在一般 I/O 的情况下，应用程序很可能很快的就写完了数据（在数据量小于缓存空间的情况下），然后去做其他事情了。这时应用程序感受不到自己被限速了，而内核在将数据从 PageCache 同步到磁盘阶段，由于 PageCache 中没有具体 cgroup 关联信息，所以所有 PageCache 的回写只能放到 cgroup 的 root 组中进行限制，而不能在其他cgroup 中进行限制，root cgroup 一般也是不做限制的。而在Direct IO的情况下，由于应用程序写的数据是不经过缓存层的，所以能直接感受到速度被限制，一定要等到整个数据按限制好的速度写完或者读完，才能返回。这就是当前 cgroup 的 blkio 限制所能起作用的环境限制。



PageCache 写入磁盘的机制：

（1）脏页太多，Page Cache 中的脏页比例达到一定阈值时回写，主要有下面两个参数来控制脏页比例：

- **dirty_background_ratio** 表示当脏页占总内存的的百分比超过这个值时，后台线程开始刷新脏页。这个值如果设置得太小，可能不能很好地利用内存加速文件操作。如果设置得太大，则会周期性地出现一个写 I/O 的峰值，默认为 10；
- **dirty_background_bytes**：和 **dirty_background_ratio** 实现相同的功能，该参数依据脏页字节数来判断，但两个参数只会有其中一个生效，默认为 0；
- **dirty_ratio** 当脏页占用的内存百分比超过此值时，内核会阻塞掉写操作，并开始刷新脏页，默认为 20；
- **dirty_bytes**：和参数 **dirty_ratio** 实现相同功能，该参数依据脏页字节数来判断，但两个参数只会有其中一个生效，默认为 0；

（2）脏页存在太久，内核线程会周期性回写，脏页存在时间主要由以下几个参数控制：

- **dirty_writeback_centisecs** 表示多久唤醒一次刷新脏页的后台线程，这个参数会和参数 **dirty_background_ratio** 一起来作用，一个表示大小比例，一个表示时间；即满足其中任何一个的条件都达到刷盘的条件，默认为 500；
- **dirty_expire_centisecs** 表示脏页超过多长时间就会被内核线程认为需要写回到磁盘，默认为 3000；

### 为什么 cgroup v1 不支持非 Buffer IO 的限制

cgroup v1 通常是每个层级对应一个子系统，子系统需要挂载使用，而每个子系统之间都是独立的，很难协同工作，比如 memory cgroup 和 blkio cgroup 能分别控制某个进程的资源使用量，但是blkio cgroup 对进程资源限制的时候无法感知 memory cgroup 中进程资源的使用量，导致对 Buffered I/O 的限制一直没有实现。



cgroup v1 结构如下所示：

![image-20210903093302380](https://cdn.tianfeiyu.com/cgroup-v1.png)



cgroup v1 因为有很多缺陷也导致了 linux 的开发者重新设计了 cgroup，也就有了 cgroup v2，在 cgroup v2 中就可以解决 Buffered I/O 限制的问题。cgroup v2 使用了统一层级（unified hierarchy)，各个子系统都可以挂载在统一层级下，一个进程属于一个控制组，每个控制组里可以定义自己需要的多个子系统。cgroup v2 中 io 子系统等同于 v1 中的 blkio 子系统。



cgroup v2 结构如下所示：

![image-20210903094916075](https://cdn.tianfeiyu.com/cgroup-v2.png)

参考：

https://www.kernel.org/doc/Documentation/cgroup-v1/blkio-controller.txt

http://kernel.pursuitofcloud.org/1780636

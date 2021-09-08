---
title: pid cgroup
date: 2021-02-03 20:50:30
tags: ["pid cgroup","cgroup v1"]
type: "pid cgroup"

---

1、为了避免系统资源被耗光，需要对进程的最大进程数进行限制，通过向对应进程所在 cgroup 的 pid.max 文件中写入具体的数字来限制其进程数。默认值为 'max' 也就是不限制，和 cgroup 最上层中的限制数保持一致。pids.current 表示 cgroup 该层路径下已经使用 pid 数量。如果 pid 已经达到上限，再创建进程会出现 Resource temporary unavailable 报错；

2、pid 被大量使用的原因：每一个进程都需要一个 pid，也会占用一定的资源，如果不限制进程数，可能会出现类似 fork bomb 耗光系统资源的问题。通常来说容器中可能由于 init 进程没有回收子进程而出现大量僵尸进程导致 pid 被耗光，当子进程退出时父进程没有回收子进程时，子进程就会成为僵尸进程；

3、系统 pid 最大值设置：pid 最大值可以在系统文件 /proc/sys/kernel/pid_max 中看到，系统在初始化时默认会设置最大值，一般小于等于 32 核的机器，pid_max 会被默认设置为 32768，大于32核的默认被设置为 核数*1024；



参考：
https://www.kernel.org/doc/Documentation/cgroup-v1/pids.txt

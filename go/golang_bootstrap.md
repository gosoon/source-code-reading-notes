---
title: Golang 程序启动流程分析
date: 2021-07-01 20:50:30
tags: ["golang runtime","plan9"]
type: "golang runtime"

---


* [Golang 代码被操作系统运行起来的流程](#golang-代码被操作系统运行起来的流程)
   * [一、编译](#一编译)
   * [二、运行](#二运行)
* [Golang 程序启动流程分析](#golang-程序启动流程分析)
   * [1、通过 gdb 调试分析程序启动流程](#1通过-gdb-调试分析程序启动流程)
   * [2、golang 启动流程分析](#2golang-启动流程分析)
   * [查看 ELF 二进制文件结构](#查看-elf-二进制文件结构)
* [总结](#总结)



> 本文使用 golang 1.17 代码，如有任何问题，还望指出。


### Golang 代码被操作系统运行起来的流程



#### 一、编译

go 源代码首先要通过 go build 编译为可执行文件，在 linux 平台上为 ELF 格式的可执行文件，编译阶段会经过编译器、汇编器、链接器三个过程最终生成可执行文件。

- 1、编译器：*.go 源码通过 go 编译器生成为 *.s 的 plan9 汇编代码，Go 编译器入口是 [compile/internal/gc/main.go](https://github.com/golang/go/blob/master/src/cmd/compile/internal/gc/main.go) 文件的 main 函数；
- 2、汇编器：通过 go 汇编器将编译器生成的 *.s 汇编语言转换为机器代码，并写出最终的目标程序 *.o 文件，[src/cmd/internal/obj ](https://github.com/golang/go/tree/master/src/cmd/internal/obj)包实现了go汇编器；
- 3、链接器：汇编器生成的一个个 *.o 目标文件通过链接处理得到最终的可执行程序，[src/cmd/link/internal/ld](https://github.com/golang/go/tree/master/src/cmd/link/internal/ld) 包实现了链接器；



![](https://cdn.tianfeiyu.com/%E7%BC%96%E8%AF%91%E6%B5%81%E7%A8%8B.png)



#### 二、运行

go 源码通过上述几个步骤生成可执行文件后，二进制文件在被操作系统加载起来运行时会经过如下几个阶段：

- 1、从磁盘上把可执行程序读入内存；

- 2、创建进程和主线程；

- 3、为主线程分配栈空间；

- 4、把由用户在命令行输入的参数拷贝到主线程的栈；

- 5、把主线程放入操作系统的运行队列等待被调度执起来运行；



### Golang 程序启动流程分析

#### 1、通过 gdb 调试分析程序启动流程

此处以一个简单的 go 程序通过单步调试来分析其启动过程的流程：

`main.go`

```
package main

import "fmt"

func main() {
	fmt.Println("hello world")
}
```



编译该程序并使用 gdb 进行调试。使用 gdb 调试时首先在程序入口处设置一个断点，然后进行单步调试即可看到该程序启动过程中的代码执行流程。

```
$ go build -gcflags "-N -l" -o main main.go

$ gdb ./main

(gdb) info files
Symbols from "/home/gosoon/main".
Local exec file:
	`/home/gosoon/main', file type elf64-x86-64.
	Entry point: 0x465860
	0x0000000000401000 - 0x0000000000497893 is .text
	0x0000000000498000 - 0x00000000004dbb65 is .rodata
	0x00000000004dbd00 - 0x00000000004dc42c is .typelink
	0x00000000004dc440 - 0x00000000004dc490 is .itablink
	0x00000000004dc490 - 0x00000000004dc490 is .gosymtab
	0x00000000004dc4a0 - 0x0000000000534b90 is .gopclntab
	0x0000000000535000 - 0x0000000000535020 is .go.buildinfo
	0x0000000000535020 - 0x00000000005432e4 is .noptrdata
	0x0000000000543300 - 0x000000000054aa70 is .data
	0x000000000054aa80 - 0x00000000005781f0 is .bss
	0x0000000000578200 - 0x000000000057d510 is .noptrbss
	0x0000000000400f9c - 0x0000000000401000 is .note.go.buildid
(gdb) b *0x465860
Breakpoint 1 at 0x465860: file /home/gosoon/golang/go/src/runtime/rt0_linux_amd64.s, line 8.
(gdb) r
Starting program: /home/gaofeilei/./main

Breakpoint 1, _rt0_amd64_linux () at /home/gaofeilei/golang/go/src/runtime/rt0_linux_amd64.s:8
8		JMP	_rt0_amd64(SB)
(gdb) n
_rt0_amd64 () at /home/gaofeilei/golang/go/src/runtime/asm_amd64.s:15
15		MOVQ	0(SP), DI	// argc
(gdb) n
16		LEAQ	8(SP), SI	// argv
(gdb) n
17		JMP	runtime·rt0_go(SB)
(gdb) n
runtime.rt0_go () at /home/gaofeilei/golang/go/src/runtime/asm_amd64.s:91
91		MOVQ	DI, AX		// argc
......
231		CALL	runtime·mstart(SB)
(gdb) n
hello world
[Inferior 1 (process 39563) exited normally]
```

通过单步调试可以看到程序入口函数在 `runtime/rt0_linux_amd64.s` 文件中的第 8 行，最终会执行 `CALL	runtime·mstart(SB)` 指令后输出 “hello world” 然后程序就退出了。

启动流程流程中的函数调用如下所示：

```
rt0_linux_amd64.s -->_rt0_amd64 --> rt0_go-->runtime·settls -->runtime·check-->runtime·args-->runtime·osinit-->runtime·schedinit-->runtime·newproc-->runtime·mstart
```

#### 2、golang 启动流程分析

上节通过gdb调试已经看到了 golang 程序在启动过程中会执行一系列的汇编指令，本节会具体分析启动程序过程中每条指令的含义，了解了这些才能明白 golang 程序在启动过程中所执行的操作。



`src/runtime/rt0_linux_amd64.s`

```
#include "textflag.h"

TEXT _rt0_amd64_linux(SB),NOSPLIT,$-8
    JMP _rt0_amd64(SB)

TEXT _rt0_amd64_linux_lib(SB),NOSPLIT,$0
    JMP _rt0_amd64_lib(SB)
```

首先执行的第8行即 `JMP _rt0_amd64`，此处在 amd64 平台下运行，`_rt0_amd64` 函数所在的文件为 `src/runtime/asm_amd64.s`。

```
TEXT _rt0_amd64(SB),NOSPLIT,$-8
    // 处理 argc 和 argv 参数，argc 是指命令行输入参数的个数，argv 存储了所有的命令行参数
    MOVQ    0(SP), DI   // argc
    // argv 为指针类型
    LEAQ    8(SP), SI   // argv
    JMP runtime·rt0_go(SB)
```

`_rt0_amd64` 函数中将 argc 和 argv 两个参数保存到 DI 和 SI 寄存器后跳转到了 `rt0_go` 函数，`rt0_go` 函数的主要作用：

- 1、将 argc、argv 参数拷贝到主线程栈上；
- 2、初始化全局变量 g0，为 g0 在主线程栈上分配大约 64K 栈空间，并设置 g0 的stackguard0，stackguard1，stack 三个字段；
- 3、执行 CPUID 指令，探测 CPU 信息；
- 4、执行 nocpuinfo 代码块判断是否需要初始化 cgo；
- 5、执行 needtls 代码块，初始化 tls 和 m0；
- 6、执行 ok 代码块，首先将 m0 和 g0 绑定，然后调用 `runtime·args` 函数处理进程参数和环境变量，调用 `runtime·osinit` 函数初始化 cpu 数量，调用 `runtime·schedinit` 初始化调度器，调用 `runtime·newproc` 创建第一个 goroutine 执行 main 函数，调用 `runtime·mstart` 启动主线程，主线程会执行第一个 goroutine 来运行 main 函数，此处会阻塞住直到进程退出；



```
TEXT runtime·rt0_go(SB),NOSPLIT|TOPFRAME,$0
    // 处理命令行参数的代码
    MOVQ    DI, AX      // AX = argc
    MOVQ    SI, BX      // BX = argv
    // 将栈扩大39字节，此处为什么扩大39字节暂时还没有搞清楚
    SUBQ    $(4*8+7), SP
    ANDQ    $~15, SP    // 调整为 16 字节对齐
    MOVQ    AX, 16(SP)  //argc放在SP + 16字节处
    MOVQ    BX, 24(SP)  //argv放在SP + 24字节处

    // 开始初始化 g0，runtime·g0 是一个全局变量，变量在 src/runtime/proc.go 中定义，全局变量会保存在进程内存空间的数据区，下文会介绍查看 elf 二进制文件中的代码数据和全局变量的方法
    // g0 的栈是从进程栈内存区进行分配的，g0 占用了大约 64k 大小。
    MOVQ    $runtime·g0(SB), DI    // g0 的地址放入 DI 寄存器
    LEAQ    (-64*1024+104)(SP), BX // BX = SP - 64*1024 + 104

    // 开始初始化 g0 对象的 stackguard0,stackguard1,stack 这三个字段
    MOVQ    BX, g_stackguard0(DI) // g0.stackguard0 = SP - 64*1024 + 104
    MOVQ    BX, g_stackguard1(DI) // g0.stackguard1 = SP - 64*1024 + 104
    MOVQ    BX, (g_stack+stack_lo)(DI) // g0.stack.lo = SP - 64*1024 + 104
    MOVQ    SP, (g_stack+stack_hi)(DI) // g0.stack.hi = SP
```

执行完以上指令后，进程内存空间布局如下所示：

![](https://cdn.tianfeiyu.com/golang%E8%BF%9B%E7%A8%8B%E5%9C%B0%E5%9D%80%E7%A9%BA%E9%97%B4.png)



然后开始执行获取 cpu 信息的指令以及与 cgo 初始化相关的，此段代码暂时可以不用关注。

```
    // 执行CPUID指令，尝试获取CPU信息，探测 CPU 和 指令集的代码
    MOVL    $0, AX
    CPUID
    MOVL    AX, SI
    CMPL    AX, $0
    JE  nocpuinfo

    // Figure out how to serialize RDTSC.
    // On Intel processors LFENCE is enough. AMD requires MFENCE.
    // Don't know about the rest, so let's do MFENCE.
    CMPL    BX, $0x756E6547  // "Genu"
    JNE notintel
    CMPL    DX, $0x49656E69  // "ineI"
    JNE notintel
    CMPL    CX, $0x6C65746E  // "ntel"
    JNE notintel
    MOVB    $1, runtime·isIntel(SB)
    MOVB    $1, runtime·lfenceBeforeRdtsc(SB)
notintel:

    // Load EAX=1 cpuid flags
    MOVL    $1, AX
    CPUID
    MOVL    AX, runtime·processorVersionInfo(SB)

nocpuinfo:
    // cgo 初始化相关，_cgo_init 为全局变量
    MOVQ    _cgo_init(SB), AX
    // 检查 AX 是否为 0
    TESTQ   AX, AX
    // 跳转到 needtls
    JZ  needtls
    // arg 1: g0, already in DI
    MOVQ    $setg_gcc<>(SB), SI // arg 2: setg_gcc

    CALL    AX

    // 如果开启了 CGO 特性，则会修改 g0 的部分字段
    MOVQ    $runtime·g0(SB), CX
    MOVQ    (g_stack+stack_lo)(CX), AX
    ADDQ    $const__StackGuard, AX
    MOVQ    AX, g_stackguard0(CX)
    MOVQ    AX, g_stackguard1(CX)
```



下面开始执行 `needtls` 代码块，初始化 tls 和 m0，tls 为线程本地存储，在 golang 程序运行过程中，每个 m 都需要和一个工作线程关联，那么工作线程如何知道其关联的 m，此时就会用到线程本地存储，线程本地存储就是线程私有的全局变量，通过线程本地存储可以为每个线程初始化一个私有的全局变量 m，然后就可以在每个工作线程中都使用相同的全局变量名来访问不同的 m 结构体对象。后面会分析到其实每个工作线程 m 在刚刚被创建出来进入调度循环之前就利用线程本地存储机制为该工作线程实现了一个指向 m 结构体实例对象的私有全局变量。

在后面代码分析中，会经常看到调用 `getg` 函数，`getg` 函数会从线程本地存储中获取当前正在运行的 g，这里获取出来的 m 关联的 g0。

tls 地址会写到 m0 中，而 m0 会和 g0 绑定，所以可以直接从 tls 中获取到 g0。

```
// 下面开始初始化tls(thread local storage，线程本地存储)，设置 m0 为线程私有变量，将 m0 绑定到主线程
needtls:
    LEAQ    runtime·m0+m_tls(SB), DI  //DI = &m0.tls，取m0的tls成员的地址到DI寄存器

    // 调用 runtime·settls 函数设置线程本地存储，runtime·settls 函数的参数在 DI 寄存器中
    // 在 runtime·settls 函数中将 m0.tls[1] 的地址设置为 tls 的地址
    // runtime·settls 函数在 runtime/sys_linux_amd64.s#599
    CALL    runtime·settls(SB)

    // 此处是在验证本地存储是否可以正常工作，确保值正确写入了 m0.tls，
    // 如果有问题则 abort 退出程序
    // get_tls 是宏，位于 runtime/go_tls.h
    get_tls(BX) 					 // 将 tls 的地址放入 BX 中,即 BX = &m0.tls[1]
    MOVQ    $0x123, g(BX)  // BX = 0x123，即 m0.tls[0] = 0x123
    MOVQ    runtime·m0+m_tls(SB), AX    // AX = m0.tls[0]
    CMPQ    AX, $0x123
    JEQ 2(PC)   								// 如果相等则向后跳转两条指令即到 ok 代码块
    CALL    runtime·abort(SB)   // 使用 INT 指令执行中断
```



继续执行 ok 代码块，主要逻辑为：

- 将 m0 和 g0 进行绑定，启动主线程；
- 调用 `runtime·osinit` 函数用来初始化 cpu 数量，调度器初始化时需要知道当前系统有多少个CPU核；
- 调用 `runtime·schedinit` 函数会初始化m0和p对象，还设置了全局变量 sched 的 maxmcount 成员为10000，限制最多可以创建10000个操作系统线程出来工作；
- 调用 `runtime·newproc` 为main 函数创建 goroutine；
- 调用 `runtime·mstart` 启动主线程，执行 main 函数；

```
// 首先将 g0 地址保存在 tls 中，即 m0.tls[0] = &g0，然后将 m0 和 g0 绑定
// 即 m0.g0 = g0, g0.m = m0
ok:
    get_tls(BX)    							// 获取tls地址到BX寄存器，即 BX = m0.tls[0]
    LEAQ    runtime·g0(SB), CX  // CX = &g0
    MOVQ    CX, g(BX) 				  // m0.tls[0]=&g0
    LEAQ    runtime·m0(SB), AX  // AX = &m0

    MOVQ    CX, m_g0(AX)  // m0.g0 = g0
    MOVQ    AX, g_m(CX)   // g0.m = m0

    CLD             // convention is D is always left cleared
    // check 函数检查了各种类型以及类型转换是否有问题，位于 runtime/runtime1.go#137 中
    CALL    runtime·check(SB)

    // 将 argc 和 argv 移动到 SP+0 和 SP+8 的位置
    // 此处是为了将 argc 和 argv 作为 runtime·args 函数的参数
    MOVL    16(SP), AX
    MOVL    AX, 0(SP)
    MOVQ    24(SP), AX
    MOVQ    AX, 8(SP)

    // args 函数会从栈中读取参数和环境变量等进行处理
    // args 函数位于 runtime/runtime1.go#61
    CALL    runtime·args(SB)

    // osinit 函数用来初始化 cpu 数量，函数位于 runtime/os_linux.go#301
    CALL    runtime·osinit(SB)
    // schedinit 函数用来初始化调度器，函数位于 runtime/proc.go#654
    CALL    runtime·schedinit(SB)

    // 创建第一个 goroutine 执行 runtime.main 函数。获取 runtime.main 的地址，调用 newproc 创建 g
    MOVQ    $runtime·mainPC(SB), AX
    PUSHQ   AX            // runtime.main 作为 newproc 的第二个参数入栈
    PUSHQ   $0            // newproc 的第一个参数入栈，该参数表示runtime.main函数需要的参数大小，runtime.main没有参数，所以这里是0

    // newproc 创建一个新的 goroutine 并放置到等待队列里，该 goroutine 会执行runtime.main 函数， 函数位于 runtime/proc.go#4250
    CALL    runtime·newproc(SB)
    // 弹出栈顶的数据
    POPQ    AX
    POPQ    AX

    // mstart 函数会启动主线程进入调度循环，然后运行刚刚创建的 goroutine，mstart 会阻塞住，除非函数退出，mstart 函数位于 runtime/proc.go#1328
    CALL    runtime·mstart(SB)

    CALL    runtime·abort(SB)   // mstart should never return
    RET

    // Prevent dead-code elimination of debugCallV2, which is
    // intended to be called by debuggers.
    MOVQ    $runtime·debugCallV2<ABIInternal>(SB), AX
    RET
```

此时进程内存空间布局如下所示：



![](https://cdn.tianfeiyu.com/golang%E8%BF%9B%E7%A8%8B%E5%9C%B0%E5%9D%80%E7%A9%BA%E9%97%B4-m0.png)





#### 查看 ELF 二进制文件结构

可以通过 readelf 命令查看 ELF 二进制文件的结构，可以看到二进制文件中代码区和数据区的内容，全局变量保存在数据区，函数保存在代码区。

```
$ readelf -s main | grep runtime.g0
  1765: 000000000054b3a0   376 OBJECT  GLOBAL DEFAULT   11 runtime.g0

// _cgo_init 为全局变量
$ readelf -s main | grep -i _cgo_init
  2159: 000000000054aa88     8 OBJECT  GLOBAL DEFAULT   11 _cgo_init
```



### 总结

本文主要介绍 Golang 程序启动流程中的关键代码，启动过程的主要代码是通过 Plan9 汇编编写的，如果没有做过底层相关的东西看起来还是非常吃力的，笔者对其中的一些细节也未完全搞懂，如果有兴趣可以私下讨论一些详细的实现细节，其中有一些硬编码的数字以及操作系统和硬件相关的规范理解起来相对比较困难。针对 Golang runtime 中的几大组件也会陆续写出相关的分析文章。



参考：

https://loulan.me/post/golang-boot/

https://mp.weixin.qq.com/s/W9D4Sl-6jYfcpczzdPfByQ

https://programmerall.com/article/6411655977/

https://ld246.com/article/1547651846124

https://zboya.github.io/post/go_scheduler/#mstartfn

https://blog.csdn.net/yockie/article/details/79166713

https://blog.csdn.net/ocean_1996/article/details/107088530

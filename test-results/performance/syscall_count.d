#!/usr/sbin/dtrace -s
/* Count syscalls per process during benchmark */
syscall:::entry
/pid == $target/
{
    @[probefunc] = count();
}

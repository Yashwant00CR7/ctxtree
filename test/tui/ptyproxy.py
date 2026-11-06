# Relay a child process through a pseudo-terminal: ptyproxy.py <cols> <rows> -- argv...
# stdin bytes go to the child's terminal; the terminal's output comes out on stdout.
import os, pty, sys, select, fcntl, termios, struct, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2]); argv = sys.argv[sys.argv.index('--')+1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
os.kill(pid, signal.SIGWINCH)
open_in = True
while True:
    fds = [fd] + ([0] if open_in else [])
    r, _, _ = select.select(fds, [], [], 0.5)
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            open_in = False
            try: os.kill(pid, signal.SIGKILL)
            except Exception: pass
        else: os.write(fd, data)
    try:
        if os.waitpid(pid, os.WNOHANG)[0]: 
            # drain
            try:
                while True:
                    d = os.read(fd, 65536)
                    if not d: break
                    os.write(1, d)
            except OSError: pass
            break
    except ChildProcessError: break

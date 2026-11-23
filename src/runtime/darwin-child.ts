// SPDX-License-Identifier: Apache-2.0
/** Fixed macOS observation program. No signal operation, shell, or selected verifier.
 * ABI: local SDK sys/proc_info.h proc_bsdinfo and sys/event.h EVFILT_PROC.
 * System Python is optional; missing interpreter/libproc/kqueue means refusal.
 */
export const DARWIN_CHILD_OBSERVER = String.raw`
import contextlib, ctypes, errno, fcntl, json, os, select, stat, sys, time, uuid

class Refusal(Exception):
    pass

def require(value, reason):
    if not value:
        raise Refusal(reason)

class BSDInfo(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint32) for n in (
        'flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','reserved')]
    _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
    _fields_ += [(n, ctypes.c_uint32) for n in ('nfiles','pgid','jobc','tdev','tpgid')]
    _fields_ += [('nice', ctypes.c_int32), ('sec', ctypes.c_uint64), ('usec', ctypes.c_uint64)]

def identity(pid, absent=False):
    require(type(pid) is int and 1 < pid < 2147483648, 'invalid-identity')
    info = BSDInfo()
    ctypes.set_errno(0)
    size = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    require(not (size == 0 and ctypes.get_errno() in (errno.EPERM, errno.EACCES)), 'identity-permission-denied')
    if size == 0 and ctypes.get_errno() == errno.ESRCH and absent:
        return None
    require(size == ctypes.sizeof(info), 'identity-unavailable')
    require(info.pid == pid and info.uid == os.getuid() and info.sec > 0 and info.usec < 1000000,
            'identity-mismatch')
    return {'pid': pid, 'start': [info.sec, info.usec]}

def private(st, directory=False):
    require(st.st_uid == os.getuid() and st.st_mode & 0o077 == 0 and
            (stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode) and st.st_nlink == 1),
            'unsafe-owned-path')

def read_file(name, limit=8192):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        st = os.fstat(fd); private(st)
        require(st.st_size <= limit, 'malformed-record')
        return os.read(fd, limit + 1), st
    finally:
        os.close(fd)

def unchanged():
    path = os.stat('gateway.lock', dir_fd=directory, follow_symlinks=False)
    private(path)
    require((path.st_dev, path.st_ino) == (lease.st_dev, lease.st_ino), 'ownership-lost')
    os.lseek(lockfd, 0, 0)
    require(os.read(lockfd, 257) == lockbytes, 'ownership-lost')
    now = os.stat(root, follow_symlinks=False)
    private(now, True)
    require((now.st_dev, now.st_ino) == (dir_stat.st_dev, dir_stat.st_ino), 'ownership-lost')

def persist(value):
    unchanged()
    name = '.child-' + uuid.uuid4().hex
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        data = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
        require(os.write(fd, data) == len(data), 'persistence-unavailable')
        os.fsync(fd)
        unchanged()
        os.rename(name, 'app-server-child.json', src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(fd)
        try: os.unlink(name, dir_fd=directory)
        except FileNotFoundError: pass

def valid_identity(value):
    return (type(value) is dict and set(value) == {'pid','start'} and type(value['pid']) is int and
            1 < value['pid'] < 2147483648 and type(value['start']) is list and len(value['start']) == 2 and
            all(type(n) is int for n in value['start']) and value['start'][0] > 0 and
            0 <= value['start'][1] < 1000000)

def load_record():
    raw, _ = read_file('app-server-child.json')
    try: record = json.loads(raw)
    except (ValueError, UnicodeError): raise Refusal('malformed-record')
    require(type(record) is dict and set(record) == {'version','bot','incarnation','host','child','state','exit','lease'},
            'malformed-record')
    require(record['version'] == 1 and record['bot'] == bot and record['incarnation'] == old_inc and
            record['lease'] == [lease.st_dev, lease.st_ino] and valid_identity(record['host']) and
            record['host']['pid'] == old_pid and valid_identity(record['child']), 'record-mismatch')
    require(record['state'] in ('running','exited'), 'malformed-record')
    if record['state'] == 'running':
        require(record['exit'] is None, 'malformed-record')
    else:
        e = record['exit']
        require(type(e) is dict and (
                (set(e) == {'source','code','signal'} and e['source'] == 'owned-child-exit' and
                 ((type(e['code']) is int and e['signal'] is None) or
                  (e['code'] is None and e['signal'] in ('SIGKILL','SIGTERM','SIGINT','SIGABRT','SIGSEGV','SIGBUS','SIGHUP','SIGQUIT','SIGPIPE','SIGALRM','SIGUSR1','SIGUSR2','SIGILL','SIGTRAP','SIGFPE','SIGXCPU','SIGXFSZ','SIGSYS')))) or
                (set(e) == {'source','waitStatus','code','signal'} and e['source'] == 'kqueue-note-exit' and
                 type(e['waitStatus']) is int and not isinstance(e['waitStatus'], bool) and e['waitStatus'] >= 0 and
                 e['code'] == (os.WEXITSTATUS(e['waitStatus']) if os.WIFEXITED(e['waitStatus']) else None) and
                 e['signal'] == (os.WTERMSIG(e['waitStatus']) if os.WIFSIGNALED(e['waitStatus']) else None) and
                 ((type(e['code']) is int and e['signal'] is None) or
                  (e['code'] is None and type(e['signal']) is int and e['signal'] > 0)))),
                'malformed-record')
    return record

def observe(record):
    host = identity(old_pid, absent=True)
    require(host is None, 'owner-live' if host == record['host'] else 'host-identity-mismatch')
    if record['state'] == 'exited':
        # Trusted private storage can still be corrupt. A persisted owned exit
        # cannot override a positive native observation of this same live child.
        # Missing/denied/unknown native support must not become guessed absence.
        current = identity(record['child']['pid'], absent=True)
        require(current is None, 'live-child-contradiction' if current == record['child'] else 'child-identity-mismatch')
        return record['exit']
    child = record['child']
    with contextlib.closing(select.kqueue()) as queue:
        # Register first, then check the microsecond start identity. PID reuse
        # before/after registration cannot turn an event into matching proof.
        change = select.kevent(child['pid'], filter=select.KQ_FILTER_PROC,
            flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT | 0x04000000)
        try: queue.control([change], 0, 0)
        except OSError: raise Refusal('exit-observation-unavailable')
        require(identity(child['pid']) == child, 'child-identity-mismatch')
        deadline = time.monotonic() + 30
        while True:
            unchanged()
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'exit-timeout')
            events = queue.control(None, 1, min(0.05, remaining))
            if not events: continue
            event = events[0]
            require(event.ident == child['pid'] and event.filter == select.KQ_FILTER_PROC and
                    event.fflags & select.KQ_NOTE_EXIT and event.fflags & 0x04000000 and
                    not event.flags & select.KQ_EV_ERROR, 'exit-observation-unavailable')
            unchanged()
            return {'source':'kqueue-note-exit', 'waitStatus':event.data,
                    'code':os.WEXITSTATUS(event.data) if os.WIFEXITED(event.data) else None,
                    'signal':os.WTERMSIG(event.data) if os.WIFSIGNALED(event.data) else None}

def main():
    global lib, root, bot, directory, dir_stat, lockfd, lease, lockbytes, old_pid, old_inc
    require(sys.platform == 'darwin' and hasattr(select, 'kqueue'), 'unsupported-platform')
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    require(ctypes.sizeof(BSDInfo) == 136, 'unsupported-identity-abi')
    request = json.loads(sys.stdin.read(8193))
    root, bot, current_inc = request['directory'], request['bot'], request['incarnation']
    require(type(bot) is str and 0 < len(bot) <= 256 and str(uuid.UUID(current_inc)) == current_inc, 'invalid-scope')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    dir_stat = os.fstat(directory); private(dir_stat, True)
    expected_lease = request.get('expectedLease')
    try:
        lockfd = os.open('gateway.lock', os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory)
    except FileNotFoundError:
        if expected_lease is not None:
            raise Refusal('ownership-lost')
        raise
    lease = os.fstat(lockfd); private(lease)
    if expected_lease is not None:
        require([lease.st_dev, lease.st_ino] == expected_lease, 'ownership-lost')
    try: fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: raise Refusal('reconciliation-busy')
    lockbytes = os.read(lockfd, 257)
    try:
        parts = lockbytes.decode().strip().split(' ')
        require(len(parts) == 2 and lockbytes == (str(int(parts[0]))+' '+str(uuid.UUID(parts[1]))+'\n').encode(), 'malformed-lock')
        old_pid, old_inc = int(parts[0]), parts[1]
    except (ValueError, UnicodeError): raise Refusal('malformed-lock')
    unchanged()
    current_pid = os.getppid()
    operation = request['operation']
    if operation == 'spawn':
        require(old_pid == current_pid and old_inc == current_inc, 'ownership-lost')
        child = identity(request['pid'])
        info = BSDInfo()
        require(lib.proc_pidinfo(child['pid'], 3, 0, ctypes.byref(info), ctypes.sizeof(info)) == ctypes.sizeof(info) and
                info.ppid == current_pid and identity(child['pid']) == child, 'unowned-child')
        host_ident = identity(current_pid)
        record = {'version':1,'bot':bot,'incarnation':current_inc,'host':host_ident,
                  'child':child,'state':'running','exit':None,'lease':[lease.st_dev,lease.st_ino]}
        persist(record)
        expected_raw, _ = read_file('app-server-child.json')
        fcntl.flock(lockfd, fcntl.LOCK_UN)
        os.close(lockfd)
        lockfd = -1
        r_fd, w_fd = os.pipe()
        watcher_pid = os.fork()
        if watcher_pid == 0:
            try:
                os.close(r_fd)
                os.setsid()
                devnull = os.open(os.devnull, os.O_RDWR)
                os.dup2(devnull, 0); os.dup2(devnull, 1); os.dup2(devnull, 2)
                if devnull > 2: os.close(devnull)
                with contextlib.closing(select.kqueue()) as queue:
                    c_ev = select.kevent(child['pid'], filter=select.KQ_FILTER_PROC,
                        flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT | 0x04000000)
                    h_ev = select.kevent(host_ident['pid'], filter=select.KQ_FILTER_PROC,
                        flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
                    queue.control([c_ev, h_ev], 0, 0)
                    require(identity(child['pid']) == child and identity(host_ident['pid']) == host_ident, 'unowned-child')
                    os.write(w_fd, b'1')
                    os.close(w_fd)
                    w_fd = -1
                    host_exited = False
                    host_exit_at = 0.0
                    child_wait = None
                    child_exit_at = 0.0
                    while not (host_exited and child_wait is not None):
                        if host_exited:
                            rem = (host_exit_at + 0.45) - time.monotonic()
                            if rem <= 0: os._exit(0)
                            wait_s = min(0.05, rem)
                        elif child_wait is not None:
                            rem = (child_exit_at + 0.45) - time.monotonic()
                            if rem <= 0: os._exit(0)
                            wait_s = min(0.05, rem)
                        else:
                            wait_s = 0.25
                        evs = queue.control(None, 2, wait_s)
                        for ev in evs:
                            if ev.filter != select.KQ_FILTER_PROC or (ev.flags & select.KQ_EV_ERROR):
                                continue
                            if ev.ident == host_ident['pid'] and (ev.fflags & select.KQ_NOTE_EXIT):
                                host_exited = True
                                host_exit_at = time.monotonic()
                            elif ev.ident == child['pid'] and (ev.fflags & select.KQ_NOTE_EXIT) and (ev.fflags & 0x04000000):
                                child_wait = int(ev.data)
                                child_exit_at = time.monotonic()
                        if not (host_exited and child_wait is not None):
                            raw_now, _ = read_file('app-server-child.json')
                            if raw_now != expected_raw: os._exit(0)
                reap_deadline = time.monotonic() + 1.0
                while time.monotonic() < reap_deadline:
                    if identity(host_ident['pid'], absent=True) is None and identity(child['pid'], absent=True) is None:
                        break
                    time.sleep(0.005)
                lockfd = os.open('gateway.lock', os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    unchanged()
                    raw_now, _ = read_file('app-server-child.json')
                    require(raw_now == expected_raw, 'record-changed')
                    require(identity(host_ident['pid'], absent=True) is None, 'owner-live')
                    require(identity(child['pid'], absent=True) is None, 'live-child-contradiction')
                    record['state'] = 'exited'
                    record['exit'] = {
                        'source': 'kqueue-note-exit',
                        'waitStatus': child_wait,
                        'code': os.WEXITSTATUS(child_wait) if os.WIFEXITED(child_wait) else None,
                        'signal': os.WTERMSIG(child_wait) if os.WIFSIGNALED(child_wait) else None,
                    }
                    persist(record)
                finally:
                    os.close(lockfd)
            except BaseException:
                if w_fd >= 0:
                    try: os.close(w_fd)
                    except OSError: pass
            os._exit(0)
        os.close(w_fd)
        ready = os.read(r_fd, 1)
        os.close(r_fd)
        require(ready == b'1', 'exit-observation-unavailable')
        return {'kind':'recorded','record':record}
    record = load_record()
    if operation == 'exit':
        require(old_pid == current_pid and old_inc == current_inc and record['child'] == request['child'] and
                record['state'] == 'running', 'ownership-lost')
        record['state'], record['exit'] = 'exited', request['exit']
        persist(record)
        return {'kind':'recorded','record':record}
    require(operation == 'reconcile' and old_inc != current_inc, 'invalid-operation')
    try:
        observed = observe(record)
    except Refusal as err:
        if str(err) != 'exit-observation-unavailable' or record['state'] != 'running':
            raise
        # Allow a concurrently completing spawn-time native kqueue observer to
        # persist its genuine KQ_NOTE_EXIT observation during zombie reap.
        fcntl.flock(lockfd, fcntl.LOCK_UN)
        settled_record = None
        handoff_deadline = time.monotonic() + 0.15
        while time.monotonic() < handoff_deadline:
            time.sleep(0.01)
            try:
                fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                continue
            unchanged()
            candidate = load_record()
            if candidate['state'] == 'exited':
                settled_record = candidate
                break
            fcntl.flock(lockfd, fcntl.LOCK_UN)
        if settled_record is None:
            raise
        record = settled_record
        observed = observe(record)
    unchanged()
    # Keep the same inode throughout; never unlink another incarnation's lock.
    # No DB or CODEX_HOME operation exists in this program.
    newbytes = (str(current_pid)+' '+current_inc+'\n').encode()
    os.lseek(lockfd, 0, 0)
    require(os.write(lockfd, newbytes) == len(newbytes), 'persistence-unavailable')
    os.ftruncate(lockfd, len(newbytes)); os.fsync(lockfd)
    return {'kind':'reconciled','previous':record,'exit':observed,'lease':[lease.st_dev,lease.st_ino]}

if __name__ == '__main__':
    try:
        print(json.dumps(main(), sort_keys=True))
    except Refusal as error:
        print(json.dumps({'kind':'refused','reason':str(error)}))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        print(json.dumps({'kind':'refused','reason':'identity-or-record-unavailable'}))
`;

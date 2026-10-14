package policy

import (
	"log"
	"sync"
	"syscall"
	"time"
)

// DiskFree is the space free to an unprivileged writer on dir's filesystem.
func DiskFree(dir string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// Floor is a Policy's Full for the disk under dir: whether less than min bytes are free there, read at most once a
// second. A reading that fails counts as room, so a broken statfs never stops the relay, and says so in the log; so
// do reaching the floor and having room again.
func Floor(dir string, min int64, free func(string) (int64, error), now func() time.Time) func() bool {
	var mu sync.Mutex
	var read time.Time
	full, failed := false, false
	return func() bool {
		mu.Lock()
		defer mu.Unlock()
		if t := now(); t.Sub(read) >= time.Second {
			read = t
			n, err := free(dir)
			if err != nil && !failed {
				log.Printf("free space under %s: %v", dir, err)
			}
			was := full
			failed, full = err != nil, err == nil && n < min
			switch {
			case full && !was:
				log.Printf("events held: the disk is nearly full (%d MB free, floor %d MB)", n>>20, min>>20)
			case was && !full:
				log.Printf("events taken again: the disk has room")
			}
		}
		return full
	}
}

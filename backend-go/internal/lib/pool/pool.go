// Package pool provides the bounded-concurrency worklist helper the
// orchestration loops use (previously part of the TTS server pool, which the
// role-worker queue replaced).
package pool

import "sync"

// Run runs items through worker with at most `concurrency` in flight. The
// first error stops dispatch of further items (in-flight ones finish) and is
// returned — used for ErrStopped propagation; per-item failures are normally
// recorded on the item instead.
func Run[T any](items []T, concurrency int, worker func(item T, index int) error) error {
	if len(items) == 0 {
		return nil
	}
	if concurrency > len(items) {
		concurrency = len(items)
	}
	var (
		next   int
		mu     sync.Mutex
		wg     sync.WaitGroup
		outErr error
	)
	for range concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if outErr != nil || next >= len(items) {
					mu.Unlock()
					return
				}
				i := next
				next++
				mu.Unlock()
				if err := worker(items[i], i); err != nil {
					mu.Lock()
					if outErr == nil {
						outErr = err
					}
					mu.Unlock()
					return
				}
			}
		}()
	}
	wg.Wait()
	return outErr
}

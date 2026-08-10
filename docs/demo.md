# Short demo: concurrent contention

With the stack ready, run:

```bash
./scripts/demo-concurrency.sh
```

The script runs concentrated contention for the same seat, performs the independent invariant audit, and displays process state. The expected outcome is business conflicts under contention with `oversold_seats=0`. To record a video or terminal cast, start your capture tool, run the script, and stop after the audit; the output contains no credentials.

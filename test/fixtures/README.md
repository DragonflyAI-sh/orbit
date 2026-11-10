# dpkg-query fixtures

Genuine, unedited lines of `dpkg-query -W` output, captured read-only (no install, no change) on 2026-11-10 in the Ubuntu runner
used by the ORBIT job runner: Ubuntu 24.04.5 LTS (noble), dpkg 1.22.6 (amd64). Lines were selected (a subset of 13 packages out of
837) with `grep`; no line was edited. The selection covers epoch versions (`1:1.16.5-...`, `2:3.8.2+...`, `1:1.3.dfsg-...`) and
arch-qualified names (`libc6:amd64`, `zlib1g:amd64`, `libstdc++6:amd64`).

- `dpkg-query-abbrev.ubuntu2404.txt`: format `${db:Status-Abbrev} ${binary:Package} ${Version}\n` (the format the old code used).
  Real lines have TWO spaces after `ii` (Status-Abbrev is three characters wide: `ii ` plus the separator).
- `dpkg-query-status-tab.ubuntu2404.txt`: format `${db:Status-Status}\t${binary:Package}\t${Version}\n` (what the code uses now).

Limitation: every package on this runner is fully installed, so no genuine line for another state (`config-files`, `half-configured`,
...) could be captured. Tests that need those states build them from a genuine line and say so; they are synthetic, not captured.

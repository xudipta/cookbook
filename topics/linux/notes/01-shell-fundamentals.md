# Shell fundamentals

## Permissions

```bash
ls -l file.sh              # -rwxr-xr-x  owner group  size  date  name
chmod +x file.sh            # add execute for everyone
chmod 644 file.txt          # rw- r-- r--  (owner rw, group/other read)
chown user:group file.txt   # change owner and group
```

Permission triplets are **owner / group / other**, each `r` (4) `w` (2) `x` (1) summed —
`755` = `rwxr-xr-x`. `x` on a directory means "can `cd` into / list contents with a known
name", not "executable".

## Processes

```bash
ps aux | grep nginx     # list processes, filter by name
ps aux --sort=-%cpu | head  # the biggest CPU users first
top / htop               # live process viewer
kill -TERM <pid>         # ask a process to exit cleanly (default signal)
kill -9 <pid>             # SIGKILL — last resort, the process can't clean up
pkill -f "node server"   # kill by matching the command line
jobs / fg / bg / Ctrl+Z  # manage jobs in the current shell session
nohup long-cmd &          # keep running after the shell exits
```

## Pipes, redirection, and exit codes

```bash
cmd1 | cmd2               # pipe stdout of cmd1 into stdin of cmd2
cmd > out.txt              # redirect stdout, overwrite
cmd >> out.txt             # redirect stdout, append
cmd 2> err.txt              # redirect stderr only
cmd > out.txt 2>&1          # redirect both to the same file
cmd1 && cmd2                # run cmd2 only if cmd1 succeeded (exit code 0)
cmd1 || cmd2                # run cmd2 only if cmd1 failed
echo $?                     # exit code of the last command
```

## Writing scripts that don't surprise you

Every script under `examples/scripts/` starts with:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

- `set -e` — exit immediately if any command fails, instead of continuing with a stale
  or missing result.
- `set -u` — treat an unset variable as an error, instead of silently expanding to `""`.
- `set -o pipefail` — a pipeline's exit code is the first non-zero one, not just the
  last command's (`false | true` would otherwise "succeed").
- Quote variable expansions (`"$var"`, `"$@"`) — unquoted, the shell word-splits on
  whitespace and glob-expands, which breaks on paths with spaces.

## Try it: `examples/scripts/backup.sh`

```bash
cd topics/linux/examples/scripts
./backup.sh /etc /tmp/backups     # tar+gzip /etc into /tmp/backups/etc-<timestamp>.tar.gz
./backup.sh                        # missing arg -> ${1:?...} prints a usage error and exits 1
```

Read the script alongside this note — `${1:?message}` is the idiomatic way to require an
argument under `set -u`, and the whole file is kept `shellcheck`-clean as a CI check.

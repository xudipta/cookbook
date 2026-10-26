# Night Shift

The pager goes off and the server is on fire. Read the symptoms, find the cause with real shell commands, and fix one thing at a time.

<div id="game" data-game="linux">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- Type commands in the terminal (Tab completes, the up arrow repeats). It is a simulated server with a
  whitelisted set of real commands: `help` lists them, and anything else points to the right note.
- **Looking is free**: `ls`, `cat`, `grep`, `ps`, `df`, `systemctl status`... never cost a move.
  A command line that **changes** something (`chmod`, `kill`, `rm`, `sed -i`, `systemctl restart`,
  `echo ... > file`) is one move and one minute. **Wait a minute** (`w`) passes time without acting.
- Every open incident costs service health each minute, and new pages arrive on a schedule. You win
  when the shift ends with nothing left open.
- Mind the blast radius. Changing something you have not looked at, `kill -9` before a plain `kill`,
  blocking the wrong client or deleting the wrong file costs health. `kill -9 1` or `rm -rf` on a system
  directory ends the shift.

## Syntax worth remembering

```bash
systemctl status web ; journalctl -u web -n 50    # is it up, and why not
ps aux --sort=-%cpu | head ; kill PID              # find the hog, ask it to stop (kill -9 only if ignored)
df -h ; du -sh /var/log/* ; truncate -s 0 FILE     # full disk: look, then truncate, do not delete an open file
grep 500 access.log | awk '{print $1}' | sort | uniq -c | sort -rn   # who causes the 500s
ss -tlnp ; curl -I localhost:8080                  # is anything listening, does it answer
chmod +x script.sh ; chown user:group FILE         # permissions
systemctl daemon-reload                            # after editing a unit file
set -euo pipefail                                  # first line of a script that must not lie
```

Troubleshooting order: status, logs, resources, network. Notes behind it:
[Shell fundamentals](../../../topics/linux/notes/01-shell-fundamentals.md),
[Text processing](../../../topics/linux/notes/02-text-processing.md) and
[systemd and networking](../../../topics/linux/notes/03-systemd-and-networking.md).

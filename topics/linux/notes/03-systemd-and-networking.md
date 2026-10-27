# systemd and networking basics

## systemd services

```bash
systemctl status nginx           # is it running, recent log lines, since when
systemctl start|stop|restart nginx
systemctl enable nginx           # start on boot
systemctl daemon-reload          # after editing a unit file
journalctl -u nginx              # that service's logs
journalctl -u nginx -f           # follow (like tail -f)
journalctl -u nginx --since "1 hour ago"
journalctl -p err -b             # errors-and-above from the current boot
```

A minimal unit file (`/etc/systemd/system/myapp.service`):

```ini
[Unit]
Description=My app
After=network.target

[Service]
ExecStart=/usr/local/bin/myapp
Restart=on-failure
User=myapp

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` + `User=myapp` (not root) covers most simple long-running services.
After adding/editing a unit file: `systemctl daemon-reload && systemctl enable --now myapp`.

## Networking

```bash
ss -tulpn                 # listening TCP/UDP sockets + owning process (replaces netstat)
ss -tan state established # established TCP connections
curl -sI https://example.com   # headers only, quick reachability check
curl -v https://example.com    # full request/response trace
dig example.com +short          # DNS resolution
ip addr                          # interfaces and their addresses
ip route                         # routing table
```

`ss -tulpn` is the fastest way to answer "what's listening on port 8080, and which
process": look at the `Local Address:Port` and `Process` columns.

## Disk and resource usage

```bash
df -h                       # filesystem space
du -h --max-depth=1 . | sort -h   # directory sizes, largest last
free -h                      # memory
nproc                        # CPU count
uptime                       # load average
find / -xdev -type f -size +1G   # what filled the disk
truncate -s 0 /var/log/app.log   # empty a log in place
```

Delete a log with `rm` and a process that still has it open keeps writing to the unlinked
file: `df` shows the same usage until that process closes it. Truncate the file (or restart the
process) instead, and remove only files nothing is using.

## Quick troubleshooting order

1. `systemctl status <service>` — is it running, what did it log on start.
2. `journalctl -u <service> -n 100` — recent log lines.
3. `ss -tulpn | grep <port>` — is something actually listening.
4. `curl -v localhost:<port>` — does the service answer locally (isolates app vs.
   network/firewall issues).

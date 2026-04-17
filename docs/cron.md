# Cron Schedule Reference

All times are EST (Eastern Standard Time). The UTC equivalent is provided for server configuration.

## Market Day Schedule (Monday-Friday)

| Time (EST) | UTC | Job | Command |
|-----------|-----|-----|---------|
| 9:00 AM | 14:00 | Strategy Scan | `MultiScan.ts` |
| 9:30 AM | 14:30 | Auto Execute | `AutoExecute.ts` |
| 3:55 PM | 20:55 | Position Monitor | `PositionMonitor.ts --auto-sell` |
| 6:00 PM | 23:00 | Daily Report | `DailyReport.ts` |

## Weekly Schedule (Friday Only)

| Time (EST) | UTC | Job | Command |
|-----------|-----|-----|---------|
| 4:30 PM | 21:30 | Portfolio Review | `PortfolioReview.ts` |
| 5:00 PM | 22:00 | Weekly Report | `WeeklyReport.ts` |

## Weekly Schedule (Sunday)

| Time | UTC | Job | Command |
|------|-----|-----|---------|
| 7:00 PM CT | 01:00 Mon | Salience Sweep | `SalienceScorer.ts --sweep` |

---

## Crontab Configuration

Add to crontab with `crontab -e`:

```cron
# Harvest Trading Pipeline

# Strategy scan (9:00 AM EST = 14:00 UTC)
0 14 * * 1-5 cd /path/to/Harvest && bun src/orchestration/MultiScan.ts >> /var/log/harvest.log 2>&1

# Auto-execute (9:30 AM EST = 14:30 UTC)
30 14 * * 1-5 cd /path/to/Harvest && bun src/execution/AutoExecute.ts >> /var/log/harvest.log 2>&1

# Position monitor (3:55 PM EST = 20:55 UTC)
55 20 * * 1-5 cd /path/to/Harvest && bun src/execution/PositionMonitor.ts --auto-sell >> /var/log/harvest.log 2>&1

# Daily report (6:00 PM EST = 23:00 UTC)
0 23 * * 1-5 cd /path/to/Harvest && bun src/reporting/DailyReport.ts >> /var/log/harvest.log 2>&1

# Friday portfolio review (4:30 PM EST = 21:30 UTC)
30 21 * * 5 cd /path/to/Harvest && bun src/reporting/PortfolioReview.ts >> /var/log/harvest.log 2>&1

# Friday weekly report (5:00 PM EST = 22:00 UTC)
0 22 * * 5 cd /path/to/Harvest && bun src/reporting/WeeklyReport.ts >> /var/log/harvest.log 2>&1

# Sunday salience sweep (7:00 PM CT = 01:00 UTC Monday)
0 1 * * 1 cd /path/to/Harvest && bun src/journal/SalienceScorer.ts --sweep >> /var/log/harvest.log 2>&1
```

---

## Daylight Saving Time Note

EST becomes EDT (UTC-4) during daylight saving time (March-November). Adjust cron UTC times:

| Job | EST | EDT (DST) | EST UTC | EDT UTC |
|-----|-----|-----------|---------|---------|
| Scan | 9:00 AM | 9:00 AM | 14:00 | 13:00 |
| Execute | 9:30 AM | 9:30 AM | 14:30 | 13:30 |
| Monitor | 3:55 PM | 3:55 PM | 20:55 | 19:55 |
| Report | 6:00 PM | 6:00 PM | 23:00 | 22:00 |
| Portfolio | 4:30 PM | 4:30 PM | 21:30 | 20:30 |
| Weekly | 5:00 PM | 5:00 PM | 22:00 | 21:00 |

Consider using a systemd timer with `America/New_York` timezone instead of cron to avoid DST issues.

---

## Systemd Timer Alternative

Create `/etc/systemd/system/harvest-scan.service`:

```ini
[Unit]
Description=Harvest Strategy Scan

[Service]
Type=oneshot
WorkingDirectory=/path/to/Harvest
ExecStart=/usr/local/bin/bun src/orchestration/MultiScan.ts
StandardOutput=append:/var/log/harvest.log
StandardError=append:/var/log/harvest.log
```

Create `/etc/systemd/system/harvest-scan.timer`:

```ini
[Unit]
Description=Run Harvest scan at 9:00 AM EST weekdays

[Timer]
OnCalendar=Mon..Fri 09:00 America/New_York
Persistent=false

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl enable --now harvest-scan.timer
```

Repeat for each job.

---

## Log Rotation

Configure logrotate at `/etc/logrotate.d/harvest`:

```
/var/log/harvest.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0640 youruser youruser
}
```

---

## Monitoring

Check recent scan output:

```bash
tail -100 /var/log/harvest.log
```

Verify cron is running:

```bash
grep harvest /var/log/syslog | tail -20
```

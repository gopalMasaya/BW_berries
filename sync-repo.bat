@echo off
:: Auto-sync script for plantsTracker repo
:: Keeps GitHub and this computer in sync in BOTH directions:
::   1. Commits any local changes as "auto-sync"
::   2. Pulls latest changes from GitHub (rebase, with autostash safety net)
::   3. Pushes local commits back up to GitHub

cd /d "C:\Users\Admin\Documents\js coding\plantsTracker"

:: 1. Stage and commit any local changes so they are never lost on pull.
::    (git commit returns an error if there is nothing to commit - that's fine.)
git add -A
git diff --cached --quiet || git commit -m "auto-sync"

:: 2. Pull latest from GitHub. --rebase keeps history linear, --autostash
::    temporarily shelves any leftover uncommitted changes during the pull.
git pull --rebase --autostash origin master 2>&1

:: 3. Push local commits back to GitHub.
git push origin master 2>&1

echo Sync completed at %date% %time% >> "%~dp0sync-log.txt"

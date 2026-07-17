@echo off
rem ATC Planner automatic backup: DB snapshot + note photos to OneDrive.
rem Scheduled daily via Task Scheduler ("ATC Planner Backup").
cd /d D:\SYS\prod-planner
node scripts\backup.mjs >> backup.log 2>&1

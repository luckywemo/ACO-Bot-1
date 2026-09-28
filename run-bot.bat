@echo off
rem ACO bot launcher — skips if :4000 is already serving, else starts the bot.
rem Used by the "ACO Mint Bot" scheduled task (runs at logon) and safe to run manually.
cd /d "C:\Users\H\Desktop\app\evi\ACO trading bot"
netstat -ano | findstr "LISTENING" | findstr ":4000 " >nul
if %errorlevel%==0 exit /b 0
npm start >> bot-run.log 2>&1

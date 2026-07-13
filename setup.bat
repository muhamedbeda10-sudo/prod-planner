@echo off
chcp 65001 >nul
echo ============================================
echo   اعداد نظام تخطيط الانتاج (اول مرة فقط)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [خطأ] Node.js غير مثبت على هذا الجهاز.
  echo ثبّت Node.js LTS من https://nodejs.org ثم شغّل هذا الملف مرة اخرى.
  pause
  exit /b 1
)

echo [1/4] تثبيت الحزم...
call npm install
if errorlevel 1 ( echo فشل التثبيت & pause & exit /b 1 )

echo [2/4] توليد Prisma Client...
call npx prisma generate
if errorlevel 1 ( echo فشل توليد Prisma & pause & exit /b 1 )

echo [3/4] تجهيز قاعدة البيانات...
call npx prisma migrate deploy
if errorlevel 1 ( echo فشل تجهيز قاعدة البيانات & pause & exit /b 1 )

echo [4/4] بناء نسخة الانتاج...
call npm run build
if errorlevel 1 ( echo فشل البناء & pause & exit /b 1 )

echo.
echo ============================================
echo   تم الاعداد بنجاح. شغّل التطبيق عبر run.bat
echo ============================================
pause

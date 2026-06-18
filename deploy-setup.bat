@echo off
REM JobPilot Deployment Setup Script
REM Run this AFTER you've created Render and Vercel services

echo.
echo ========================================
echo   JobPilot Deployment Setup
echo ========================================
echo.

REM Check Git
git --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed or not in PATH
    pause
    exit /b 1
)

echo [1/4] Checking Git status...
git status
echo.

echo [2/4] Adding deployment files to Git...
git add .github/workflows/deploy-render-vercel.yml
git add render.yaml
git add frontend/vercel.json
git add DEPLOYMENT_GUIDE.md
git add DEPLOYMENT_CHECKLIST.md
git status
echo.

echo [3/4] Creating deployment commit...
git commit -m "Add deployment configuration for Render + Vercel + GitHub Actions"
echo.

echo [4/4] Ready to push to GitHub
echo.
echo Next steps:
echo 1. Go to https://render.com and create a Web Service (connect your repo)
echo 2. Go to https://vercel.com and create a Project (import your repo)
echo 3. Get API keys from both services
echo 4. Add GitHub Secrets (see DEPLOYMENT_GUIDE.md for details)
echo 5. Run: git push origin main
echo.
echo After push, both services will auto-deploy!
echo.

pause

@echo off
rem Mock GitHub CLI for the M4 one-click acceptance walkthrough.
rem Records the invocation and prints a PR URL, like real `gh pr create`.
if "%~1"=="--version" (
  echo gh version 2.63.0-mock
  exit /b 0
)
if "%~1"=="pr" if "%~2"=="create" (
  set ARGS=%*
  echo Creating pull request for branch...
  echo https://github.local/pult-mock/mock-repo/pull/42
  echo mock gh invocation: %*>> "%~dp0..\gh-mock-log.txt"
  exit /b 0
)
echo mock gh: unexpected command %* 1>&2
exit /b 1

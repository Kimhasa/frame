@echo off
set VSLANG=1033
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0.."
cmake -S native -B build\native -G Ninja -DCMAKE_BUILD_TYPE=Release || exit /b 1
cmake --build build\native || exit /b 1

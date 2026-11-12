; ===========================================================================
;  FatFish (肥鱼聊天) Windows installer
; ---------------------------------------------------------------------------
;  Hand-written NSIS script that packages the electron-builder "win-unpacked"
;  directory into a single installable .exe.
;
;  Why not electron-builder's own NSIS target: that target builds a throw-away
;  installer variant with BUILD_UNINSTALLER defined and *executes* it to obtain
;  the uninstaller binary, launching it through builder-util's exec with an
;  environment containing only __COMPAT_LAYER. In a locked-down shell that child
;  exits non-zero (after still writing the file), which aborts the whole build.
;  This script instead uses standard NSIS behaviour -- the uninstaller is written
;  into the install directory at install time by WriteUninstaller -- so no helper
;  process ever has to be executed during the build.
;
;  Characteristics:
;    * per-user install (no UAC), default %LOCALAPPDATA%\Programs\FatFish
;    * lets the user choose the directory
;    * desktop + start-menu shortcuts, Add/Remove Programs entry
;    * uninstaller leaves %APPDATA%\FatFish (the user's messages) untouched
;
;  Build with:
;    makensis /DAPP_DIR=<...\win-unpacked> /DOUT_FILE=<...\FatFish-Setup.exe> \
;             /DAPP_VERSION=1.0.0 fatfish-installer.nsi
; ===========================================================================

Unicode true
; Non-solid compression on purpose.
;
; A SOLID compressor (lzma/bzip2 with /SOLID) makes NSIS unpack the entire data
; block into a temporary file under %TEMP% before it can show anything. On
; machines where that file is refused -- restricted/hardened temp directories, or
; security software that blocks files opened with FILE_FLAG_DELETE_ON_CLOSE --
; the installer dies with "Error writing temporary file" before the first page
; ever appears, which reads to the user as "double-click does nothing". Non-solid
; blocks are streamed at install time instead, so no temp file is needed at all
; and the wizard always shows. The cost is a larger installer, which is the right
; trade for a build that runs everywhere.
SetCompressor bzip2

!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef APP_DIR
  !error "APP_DIR must be defined (path to the electron-builder win-unpacked directory)"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE must be defined (path of the installer to produce)"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
; Where launcher-browser.* and launcher-stop.cmd live. Defaults to the directory
; holding this script, which is how the repository is laid out.
!ifndef LAUNCHER_DIR
  !define LAUNCHER_DIR "${__FILEDIR__}"
!endif

; Display name. Latin, matching the executable and the package file name -- the
; product used to be called "肥鱼聊天" in Chinese, and some of its users still
; look for that name, which is why the install section removes the old shortcuts.
!define APP_NAME "FatFish"
!define APP_NAME_EN "FatFish"
!define APP_PUBLISHER "FatFish contributors"
!define APP_EXE "FatFish.exe"
!define APP_ID "com.fatfish.desktop"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FatFish"
!define UNINST_EXE "Uninstall.exe"

Name "${APP_NAME}"
BrandingText "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME_EN}"
InstallDirRegKey HKCU "Software\${APP_NAME_EN}" "InstallDir"
; Per-user install: never ask for elevation, so a non-admin user can install.
RequestExecutionLevel user

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${APP_PUBLISHER}"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------
Section "install"
  ; Upgrading means installing over the previous version, in the same directory --
  ; $INSTDIR comes from InstallDirRegKey above when an older copy is registered.
  ;
  ; Two things have to happen before any file is written:
  ;
  ; 1. Stop whatever is running out of this installation. Windows will not let a
  ;    running exe or a mapped dll be replaced, and NSIS would then skip those
  ;    files silently, leaving a mix of old and new binaries behind. The
  ;    uninstaller already does this; an upgrade needs it just as much.
  ; 2. Nothing else: the chat database, uploads and avatars live in
  ;    %APPDATA%\FatFish, outside $INSTDIR, so an upgrade never touches them.
  ExecWait '"$SYSDIR\taskkill.exe" /IM ${APP_EXE} /F' $R0
  ExecWait '"$SYSDIR\taskkill.exe" /IM minimost-server.exe /F' $R0
  Sleep 700

  SetOutPath "$INSTDIR"

  ; A silent install that fails mid-section exits with code 0 and says nothing,
  ; which is how "files are there but no shortcuts appeared" happened. This log
  ; records how far the section got; NSIS writes it straight to disk.
  FileOpen $9 "$INSTDIR\_setup.log" w
  FileWrite $9 "start:$\r$\n"
  FileWrite $9 "  INSTDIR=$INSTDIR$\r$\n"
  FileWrite $9 "  DESKTOP=$DESKTOP$\r$\n"
  FileWrite $9 "  SMPROGRAMS=$SMPROGRAMS$\r$\n"
  FileWrite $9 "  APPDATA=$APPDATA$\r$\n"

  ; Whether this is an upgrade or a first install, decided by what was there
  ; before the file copy.
  IfFileExists "$INSTDIR\${APP_EXE}" 0 not_upgrade
    FileWrite $9 "  mode=upgrade (previous version found)$\r$\n"
    Goto upgrade_done
  not_upgrade:
    FileWrite $9 "  mode=fresh install$\r$\n"
  upgrade_done:

  ; The whole Electron app: FatFish.exe, resources/app.asar and
  ; resources/server (the frozen Python backend).
  File /r "${APP_DIR}\*.*"

  ; Browser-mode launchers. FatFish.exe needs Chromium, which some machines'
  ; graphics stack or security policy refuses to start; the backend underneath is
  ; an ordinary program and serves the very same interface, so a second shortcut
  ; gives those users a working app instead of a flashing window.
  File "${LAUNCHER_DIR}\launcher-browser.cmd"
  File "${LAUNCHER_DIR}\launcher-browser.ps1"
  File "${LAUNCHER_DIR}\launcher-stop.cmd"

  ; Write the uninstaller into the install directory at install time.
  WriteUninstaller "$INSTDIR\${UNINST_EXE}"

  ; The uninstaller is an NSIS program too, and NSIS uninstallers re-launch
  ; themselves from %TEMP%. On a machine whose per-user temp folder is unusable
  ; that means "uninstall does nothing", so both the shortcut and the Add/Remove
  ; Programs entry go through a launcher that sets a working TEMP first.
  File "${LAUNCHER_DIR}\launcher-uninstall.cmd"

  ; Shortcuts. The browser-mode one is created first in the start menu because on
  ; a machine where the window cannot start it is the one that works.
  ;
  ; The Chinese names below are the product's previous name. Deleting them here
  ; means an upgrade does not leave a second, dead shortcut behind. Guarded with
  ; IfFileExists because RMDir on a missing directory sets the error flag, and an
  ; error inside a silent install ends the section without a word.
  FileWrite $9 "  reached shortcuts$\r$\n"

  IfFileExists "$DESKTOP\肥鱼聊天.lnk" 0 old_desktop_done
    Delete "$DESKTOP\肥鱼聊天.lnk"
  old_desktop_done:
  IfFileExists "$DESKTOP\肥鱼聊天（浏览器模式）.lnk" 0 old_browser_done
    Delete "$DESKTOP\肥鱼聊天（浏览器模式）.lnk"
  old_browser_done:
  IfFileExists "$SMPROGRAMS\肥鱼聊天" 0 old_menu_done
    RMDir /r "$SMPROGRAMS\肥鱼聊天"
  old_menu_done:

  FileWrite $9 "  deleted old shortcuts$\r$\n"

  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  FileWrite $9 "  desktop shortcut ok$\r$\n"
  CreateShortcut "$DESKTOP\${APP_NAME}（浏览器模式）.lnk" "$INSTDIR\launcher-browser.cmd" "" "$INSTDIR\${APP_EXE}" 0
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}（浏览器模式）.lnk" "$INSTDIR\launcher-browser.cmd" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\停止 ${APP_NAME}.lnk" "$INSTDIR\launcher-stop.cmd"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\launcher-uninstall.cmd" "" "$INSTDIR\${APP_EXE}" 0
  FileWrite $9 "  start menu shortcuts ok$\r$\n"

  ; Add/Remove Programs entry (per-user, so HKCU).
  WriteRegStr HKCU "Software\${APP_NAME_EN}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  ; The Add/Remove Programs entry goes through the same launcher as the shortcut,
  ; for the same reason: the raw Uninstall.exe cannot start on a machine whose
  ; %TEMP% is unusable.
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\launcher-uninstall.cmd"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\launcher-uninstall.cmd" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  FileWrite $9 "  registry ok$\r$\n"

  ; Installed size, shown next to the entry in Settings > Apps.
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  FileWrite $9 "done$\r$\n"
  FileClose $9
SectionEnd

; ---------------------------------------------------------------------------
Section "Uninstall"
  ; Stop anything still running from this install directory before deleting it.
  ExecWait '"$SYSDIR\taskkill.exe" /IM ${APP_EXE} /F' $R0
  ExecWait '"$SYSDIR\taskkill.exe" /IM minimost-server.exe /F' $R0
  Sleep 700

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}（浏览器模式）.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}（浏览器模式）.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\停止 ${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  ; The install-time trace of the section above, if this build wrote one.
  Delete "$INSTDIR\_setup.log"

  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME_EN}"

  ; The chat database, uploads and avatars live in %APPDATA%\FatFish and are
  ; deliberately preserved: uninstalling the program must not destroy the
  ; user's message history.
SectionEnd

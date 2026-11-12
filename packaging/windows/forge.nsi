; Forge ERP setup program. Built by packaging/windows/build.sh with makensis.
; A wizard like any Windows product: welcome, notice, folder, administrator account,
; install, finish. It fetches and checks what it needs, sets up two Windows services,
; adds shortcuts and an uninstaller, and updates an existing install in place.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define APP "Forge ERP"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeERP"
!define APPURL "http://localhost:4100/"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$PROGRAMFILES64\Forge ERP"
RequestExecutionLevel admin
BrandingText "${APP} ${VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} setup"
VIAddVersionKey "CompanyName" "${APP}"
VIAddVersionKey "LegalCopyright" "${APP}"

Var DataDir
Var IsUpgrade
Var AdminName
Var AdminEmail
Var AdminPass
Var AllowNetwork
Var Dialog
Var NameBox
Var EmailBox
Var PassBox
Var Pass2Box
Var NetBox
Var Node
Var Setup

!define MUI_ICON "${BUILD}/forge.ico"
!define MUI_UNICON "${BUILD}/forge.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APP} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This sets up ${APP} on this computer.$\r$\n$\r$\nSetup downloads Node.js and MongoDB, about 650 MB in all, and checks each one before using it. Keep this computer connected to the internet until setup finishes.$\r$\n$\r$\nIf ${APP} is already installed, setup updates it and keeps your data."
!insertmacro MUI_PAGE_WELCOME
!define MUI_LICENSEPAGE_TEXT_TOP "Please read this before you install."
!insertmacro MUI_PAGE_LICENSE "notice.txt"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpgrade
!insertmacro MUI_PAGE_DIRECTORY
Page custom AccountPage AccountLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "${APP} is ready"
!define MUI_FINISHPAGE_TEXT "${APP} runs in the background and starts with Windows.$\r$\n$\r$\nOpen it from the desktop or the Start menu, or go to ${APPURL} in your browser."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP} now"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenForge
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APP} needs 64-bit Windows." /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "${APP} needs Windows 10 or later." /SD IDOK
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  StrCpy $DataDir "$APPDATA\Forge ERP"
  StrCpy $AdminName "Administrator"
  ReadRegStr $0 HKLM "${UNINSTKEY}" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\app\server\server.js"
    StrCpy $INSTDIR $0
    StrCpy $IsUpgrade 1
  ${Else}
    StrCpy $IsUpgrade 0
  ${EndIf}
FunctionEnd

Function SkipIfUpgrade
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}
FunctionEnd

; The first administrator. An update keeps the people already set up.
Function AccountPage
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Your administrator account" "Setup creates this sign-in for you. You can add other people later."
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 10u "Your name"
  Pop $0
  ${NSD_CreateText} 0 11u 100% 12u "$AdminName"
  Pop $NameBox
  ${NSD_CreateLabel} 0 28u 100% 10u "Email, used to sign in"
  Pop $0
  ${NSD_CreateText} 0 39u 100% 12u "$AdminEmail"
  Pop $EmailBox
  ${NSD_CreateLabel} 0 56u 48% 10u "Password, at least 10 characters"
  Pop $0
  ${NSD_CreatePassword} 0 67u 48% 12u ""
  Pop $PassBox
  ${NSD_CreateLabel} 52% 56u 48% 10u "Type the password again"
  Pop $0
  ${NSD_CreatePassword} 52% 67u 48% 12u ""
  Pop $Pass2Box
  ${NSD_CreateCheckbox} 0 90u 100% 12u "Let other computers on this network open ${APP}"
  Pop $NetBox
  ${If} $AllowNetwork == ${BST_CHECKED}
    ${NSD_Check} $NetBox
  ${EndIf}
  ${NSD_CreateLabel} 0 106u 100% 26u "Leave this off if only this computer will use ${APP}. Turning it on opens port 4100 in Windows Firewall, and others then reach it at this computer's address."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function AccountLeave
  ${NSD_GetText} $NameBox $AdminName
  ${NSD_GetText} $EmailBox $AdminEmail
  ${NSD_GetText} $PassBox $AdminPass
  ${NSD_GetText} $Pass2Box $1
  ${NSD_GetState} $NetBox $AllowNetwork
  ${If} $AdminName == ""
    StrCpy $AdminName "Administrator"
  ${EndIf}
  ; An email needs an @ with something on each side.
  StrCpy $2 0
  StrCpy $3 ""
  ${Do}
    StrCpy $4 $AdminEmail 1 $2
    ${If} $4 == ""
      ${ExitDo}
    ${EndIf}
    ${If} $4 == "@"
    ${AndIf} $2 > 0
      StrCpy $3 "found"
    ${EndIf}
    IntOp $2 $2 + 1
  ${Loop}
  StrCpy $4 $AdminEmail 1 -1
  ${If} $3 != "found"
  ${OrIf} $4 == "@"
    MessageBox MB_ICONEXCLAMATION "Enter a valid email address."
    Abort
  ${EndIf}
  StrLen $2 $AdminPass
  ${If} $2 < 10
    MessageBox MB_ICONEXCLAMATION "The password needs at least 10 characters."
    Abort
  ${EndIf}
  ${If} $AdminPass != $1
    MessageBox MB_ICONEXCLAMATION "The two passwords are not the same."
    Abort
  ${EndIf}
FunctionEnd

!macro Run COMMAND FAILURE
  nsExec::ExecToLog '${COMMAND}'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "${FAILURE}$\r$\n$\r$\nThe details are in the list on this page. Setup can be run again, and it keeps what is already done." /SD IDOK
    Abort "${FAILURE}"
  ${EndIf}
!macroend

Section "${APP}" SecMain
  SectionIn RO
  SetDetailsPrint both

  ${If} $IsUpgrade == 1
    DetailPrint "Stopping ${APP} to update it."
    nsExec::ExecToLog '"$INSTDIR\service\ForgeService.exe" stop'
    Pop $0
    nsExec::ExecToLog 'net stop ForgeDB'
    Pop $0
    RMDir /r "$INSTDIR\app"
  ${EndIf}

  SetOutPath "$INSTDIR"
  File "${BUILD}/forge.ico"
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}/app/*.*"
  SetOutPath "$INSTDIR\setup"
  File "install-runtime.ps1"
  SetOutPath "$INSTDIR\service"
  File "/oname=ForgeService.exe" "${STAGE}/WinSW.NET461.exe"
  File "/oname=WinSW-LICENSE.txt" "${STAGE}/WinSW-LICENSE.txt"
  SetOutPath "$INSTDIR"

  DetailPrint "Fetching Node.js and MongoDB, and checking each against its published checksum."
  ; Setup is a 32-bit program. Sysnative reaches the 64-bit PowerShell, so curl, tar and
  ; the downloads run as 64-bit, not through Windows' 32-bit redirection.
  StrCpy $R9 "$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$R9"
    StrCpy $R9 "powershell.exe"
  ${EndIf}
  !insertmacro Run '"$R9" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\setup\install-runtime.ps1" -InstallDir "$INSTDIR"' "Setup could not download Node.js or MongoDB. What went wrong is listed on this page (Show details), and kept in $TEMP\forge-setup\setup.log.$\r$\n$\r$\nIf this PC uses a proxy or firewall, it must allow nodejs.org and fastdl.mongodb.org."

  StrCpy $Node '"$INSTDIR\runtime\node\node.exe"'
  StrCpy $Setup '"$INSTDIR\app\server\scripts\windowsSetup.js"'
  ${If} $IsUpgrade == 1
    StrCpy $1 "keep"
  ${ElseIf} $AllowNetwork == ${BST_CHECKED}
    StrCpy $1 "0.0.0.0"
  ${Else}
    StrCpy $1 "127.0.0.1"
  ${EndIf}
  !insertmacro Run '$Node $Setup prepare --data "$DataDir" --host $1' "Setup could not write the settings."

  DetailPrint "Starting the database service."
  nsExec::ExecToLog 'sc query ForgeDB'
  Pop $0
  ${If} $0 != 0
    !insertmacro Run '"$INSTDIR\runtime\mongodb\mongod.exe" --config "$DataDir\mongod.cfg" --install --serviceName ForgeDB --serviceDisplayName "Forge ERP database" --serviceDescription "Stores the Forge ERP data."' "Setup could not create the database service."
  ${EndIf}
  nsExec::ExecToLog 'net start ForgeDB'
  Pop $0
  !insertmacro Run '$Node $Setup replset --data "$DataDir"' "The database did not start."

  ${If} $IsUpgrade == 0
    DetailPrint "Creating your administrator account."
    System::Call 'Kernel32::SetEnvironmentVariable(t "ADMIN_EMAIL", t "$AdminEmail")'
    System::Call 'Kernel32::SetEnvironmentVariable(t "ADMIN_NAME", t "$AdminName")'
    System::Call 'Kernel32::SetEnvironmentVariable(t "ADMIN_PASSWORD", t "$AdminPass")'
    System::Call 'Kernel32::SetEnvironmentVariable(t "ADMIN_IF_NONE", t "1")'
    nsExec::ExecToLog '$Node --env-file="$DataDir\forge.env" "$INSTDIR\app\server\scripts\createAdmin.js"'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ADMIN_PASSWORD", p 0)'
    StrCpy $AdminPass ""
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Setup could not create the administrator account." /SD IDOK
      Abort "Setup could not create the administrator account."
    ${EndIf}
  ${EndIf}

  ; The service definition is written fresh each time, so an update or repair puts it right.
  FileOpen $2 "$INSTDIR\service\ForgeService.xml" w
  FileWrite $2 '<service>$\r$\n'
  FileWrite $2 '  <id>ForgeERP</id>$\r$\n'
  FileWrite $2 '  <name>Forge ERP</name>$\r$\n'
  FileWrite $2 '  <description>The Forge ERP web application.</description>$\r$\n'
  FileWrite $2 '  <executable>$INSTDIR\runtime\node\node.exe</executable>$\r$\n'
  FileWrite $2 '  <arguments>--env-file="$DataDir\forge.env" server.js</arguments>$\r$\n'
  FileWrite $2 '  <workingdirectory>$INSTDIR\app\server</workingdirectory>$\r$\n'
  FileWrite $2 '  <depend>ForgeDB</depend>$\r$\n'
  FileWrite $2 '  <startmode>Automatic</startmode>$\r$\n'
  FileWrite $2 '  <onfailure action="restart" delay="10 sec"/>$\r$\n'
  FileWrite $2 '  <onfailure action="restart" delay="30 sec"/>$\r$\n'
  FileWrite $2 '  <logpath>$DataDir\logs</logpath>$\r$\n'
  FileWrite $2 '  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>$\r$\n'
  FileWrite $2 '</service>$\r$\n'
  FileClose $2

  DetailPrint "Starting ${APP}."
  nsExec::ExecToLog 'sc query ForgeERP'
  Pop $0
  ${If} $0 != 0
    !insertmacro Run '"$INSTDIR\service\ForgeService.exe" install' "Setup could not create the ${APP} service."
  ${EndIf}
  !insertmacro Run '"$INSTDIR\service\ForgeService.exe" start' "The ${APP} service did not start."
  nsExec::ExecToLog '$Node $Setup wait-ready --data "$DataDir"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "${APP} is installed, but has not answered yet. Give it a minute, then open it. If it still does not open, the logs are in $DataDir\logs" /SD IDOK
  ${EndIf}

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Forge ERP"'
  Pop $0
  ${If} $AllowNetwork == ${BST_CHECKED}
    DetailPrint "Opening port 4100 in Windows Firewall."
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Forge ERP" dir=in action=allow protocol=TCP localport=4100'
    Pop $0
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\Forge ERP"
  CreateShortCut "$SMPROGRAMS\Forge ERP\Forge ERP.lnk" "$WINDIR\explorer.exe" "${APPURL}" "$INSTDIR\forge.ico" 0
  CreateShortCut "$SMPROGRAMS\Forge ERP\Forge ERP data and backups.lnk" "$DataDir"
  CreateShortCut "$SMPROGRAMS\Forge ERP\Uninstall Forge ERP.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\Forge ERP.lnk" "$WINDIR\explorer.exe" "${APPURL}" "$INSTDIR\forge.ico" 0

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${APP}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\forge.ico"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "URLInfoAbout" "${APPURL}"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Function OpenForge
  ExecShell "open" "${APPURL}"
FunctionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext all
  StrCpy $DataDir "$APPDATA\Forge ERP"
FunctionEnd

Section "Uninstall"
  DetailPrint "Stopping and removing the services."
  nsExec::ExecToLog '"$INSTDIR\service\ForgeService.exe" stop'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\service\ForgeService.exe" uninstall'
  Pop $0
  nsExec::ExecToLog 'net stop ForgeDB'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\runtime\mongodb\mongod.exe" --remove --serviceName ForgeDB'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Forge ERP"'
  Pop $0

  Delete "$DESKTOP\Forge ERP.lnk"
  RMDir /r "$SMPROGRAMS\Forge ERP"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTKEY}"

  ; The data is the company's books, so it stays unless someone says otherwise.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete all Forge data, including the database and every backup in $DataDir?$\r$\n$\r$\nThis cannot be undone. Choose No to keep it." /SD IDNO IDNO keepData
    RMDir /r "$DataDir"
  keepData:
SectionEnd

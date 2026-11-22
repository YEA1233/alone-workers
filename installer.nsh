!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"

  Var startMenuShortcutCheckbox
  Var desktopShortcutCheckbox
  Var startMenuShortcutEnabled
  Var desktopShortcutEnabled

  !macro customInit
    StrCpy $startMenuShortcutEnabled ${BST_CHECKED}
    StrCpy $desktopShortcutEnabled ${BST_CHECKED}
    ReadRegStr $0 SHELL_CONTEXT "Software\ALONE\LauncherSetup" "StartMenuShortcut"
    ${if} $0 == "0"
      StrCpy $startMenuShortcutEnabled ${BST_UNCHECKED}
    ${endIf}
    ReadRegStr $0 SHELL_CONTEXT "Software\ALONE\LauncherSetup" "DesktopShortcut"
    ${if} $0 == "0"
      StrCpy $desktopShortcutEnabled ${BST_UNCHECKED}
    ${endIf}
  !macroend

  !macro customPageAfterChangeDir
    PageEx custom
      PageCallbacks ShortcutOptionsPage ShortcutOptionsLeave
    PageExEnd
  !macroend

  Function ShortcutOptionsPage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 18u "Choose which shortcuts to create:"
    Pop $0
    ${NSD_CreateCheckbox} 0 24u 100% 14u "Create a Start Menu shortcut"
    Pop $startMenuShortcutCheckbox
    ${if} $startMenuShortcutEnabled == ${BST_CHECKED}
      ${NSD_Check} $startMenuShortcutCheckbox
    ${else}
      ${NSD_Uncheck} $startMenuShortcutCheckbox
    ${endIf}

    ${NSD_CreateCheckbox} 0 46u 100% 14u "Create a desktop shortcut"
    Pop $desktopShortcutCheckbox
    ${if} $desktopShortcutEnabled == ${BST_CHECKED}
      ${NSD_Check} $desktopShortcutCheckbox
    ${else}
      ${NSD_Uncheck} $desktopShortcutCheckbox
    ${endIf}
    nsDialogs::Show
  FunctionEnd

  Function ShortcutOptionsLeave
    ${NSD_GetState} $startMenuShortcutCheckbox $startMenuShortcutEnabled
    ${NSD_GetState} $desktopShortcutCheckbox $desktopShortcutEnabled
  FunctionEnd

  !macro customInstall
    ${if} $startMenuShortcutEnabled == ${BST_CHECKED}
      CreateDirectory "$SMPROGRAMS\ALONE"
      ${ifNot} ${FileExists} "$newStartMenuLink"
        CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0
      ${endIf}
    ${else}
      Delete "$newStartMenuLink"
      RMDir "$SMPROGRAMS\ALONE"
    ${endIf}
    ${if} $desktopShortcutEnabled == ${BST_CHECKED}
      ${ifNot} ${FileExists} "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0
      ${endIf}
    ${else}
      Delete "$newDesktopLink"
    ${endIf}
    WriteRegStr SHELL_CONTEXT "Software\ALONE\LauncherSetup" "StartMenuShortcut" "$startMenuShortcutEnabled"
    WriteRegStr SHELL_CONTEXT "Software\ALONE\LauncherSetup" "DesktopShortcut" "$desktopShortcutEnabled"
    WriteRegStr SHELL_CONTEXT "Software\ALONE\LauncherSetup" "Installed" "1"
  !macroend
!endif

!macro customUnInstall
  ${ifNot} ${Silent}
    DeleteRegKey SHELL_CONTEXT "Software\ALONE\LauncherSetup"
  ${endIf}
!macroend

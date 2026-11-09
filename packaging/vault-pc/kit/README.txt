FORGE VAULT PC KIT
==================

What it adds on a Windows PC:
  - Badges on files in the Forge Vault folder:
      green pencil = locked by you
      red lock     = locked by someone else
      blue tick    = released
  - A "Forge" tab in SOLIDWORKS (parts, assemblies, drawings) and a Forge Vault panel in
    the Task Pane: pull, push, lock, unlock, send for review, release, new revision, and
    the open file's versions and history.

Order:
  1. In Forge, Drawing vault > Access and set-up > Designers' PCs: make this PC's file.
     Right-click it > Run with PowerShell. This makes the Forge Vault folder.
  2. Unzip this kit anywhere and double-click Install.cmd. Say Yes to the
     administrator question. It builds on this PC with the compiler that comes with
     Windows, so nothing is downloaded.
  3. Start SOLIDWORKS. If the Forge tab is missing: Tools > Add-Ins, tick Forge Vault.

To remove: double-click Uninstall.cmd.
A log of the install is kept in %TEMP%\ForgeVault-kit-install.log.

Built from source here on purpose: you can read every line (ForgeVaultOverlay.cs,
ForgeVaultAddin.cs) before it runs. MIT licence, part of Forge ERP.

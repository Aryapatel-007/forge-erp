#!/bin/bash
# Removes Forge ERP from this Mac. Run it in Terminal with:
#   sudo "/Library/Application Support/Forge ERP/program/setup/uninstall.sh"
# It asks before deleting the data, which holds the company's books.
set -u
if [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo, as shown at the top of this file."
  exit 1
fi
for label in com.forge-erp.app com.forge-erp.database; do
  launchctl bootout "system/$label" 2> /dev/null || true
  rm -f "/Library/LaunchDaemons/$label.plist"
done
rm -rf "/Applications/Forge ERP.app" "/Library/Application Support/Forge ERP/program" "/Library/Logs/Forge ERP"
pkgutil --forget com.forge-erp.pkg > /dev/null 2>&1 || true
echo "Forge ERP is removed."
printf 'Also delete all Forge data, including the database and every backup? This cannot be undone. [y/N] '
read -r answer
case "$answer" in
  [yY]*) rm -rf "/Library/Application Support/Forge ERP" && echo "The data is deleted." ;;
  *) echo "The data is kept in /Library/Application Support/Forge ERP/data" ;;
esac

# Using lva-installer

This guide will tell you how to downlaod lva-installer and use it to write lva-os onto a storage device.

## Download lva-installer

### Windows

1. Go to the releases tab on github and download the latest windows version of lva-installer.
2. Unzip lva-installer into a new folder.
3. Run lva-installer.exe

### Mac OS 

1. Go to the releases tab on github and download the latest macos(x86 or arm) version of lva-installer.
2. Extract lva-installer into a new directory.
3. Run the lva-installer executable.

### Linux

1. Go to the releases tab on github and download the latest linux(x86 or arm) version of lva-installer.
2. Extract lva-installer into a new directory.
3. Run the lva-installer executable.

## Using lva-installer

You should now have arrived at the lva-installer TUI.

1. **Selecting the target board**
You can choose between all of the target platforms for lva-os using the arrow keys.

2. **Network**
The installer allows you to choose between using Ethernet for the device or provide a SSID and Password, the WiFi country code(2 letter) for your country is avialable [here](https://www.iban.com/country-codes).

3. **Timezone**
Lva-installer automatically detects the timezone from the device, if you want to use another timezone, you can see the IANA timezone list [here](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

4. **Choose a storage device**
Now you can choose which drive you want to install lva-os to, keep in mind **all data on the device will permanently be erased**.

5. **Download and Install**
Lva-installer will now pull the latest lva-os image for your board and then write it to the storage device.

If all goes well, you should now have a storage device with lva-os installed!


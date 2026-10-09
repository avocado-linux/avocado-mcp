// Trimmed from peridio/docs src/src/data/hardware/{targets,supported,virtual-environment}.json
// at e3d361f3, with images removed.
export const TARGETS = {
  rubikpi3: {
    name: "Thundercomm Rubik Pi 3",
    target: "rubikpi3",
    releases: {
      "2024": "supported",
      "2026": "in-progress",
    },
    category: "physical",
    description:
      "The Rubik Pi 3 is provisioned by flashing the board's onboard UFS storage over USB while the device is in Qualcomm EDL (Emergency Download) mode.",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "Thundercomm Rubik Pi 3",
        "USB-C power cable + a PD 3.0 compliant 12V/3A adapter for the power input (port 10) — bus power is not enough. The power LED only lights when PD negotiation succeeds; if it stays off the board will not boot.",
        "USB-C (or USB-C-to-A) data cable for flashing, from the board's USB-C port (port 5) to your host",
        "Micro-USB cable for the debug UART console (Micro-USB port, port 2) — leave this disconnected during provisioning/flashing; connect it only after provisioning succeeds",
      ],
      options: [
        {
          id: "ufs",
          label: "UFS (EDL)",
          profile: "ufs",
          media: "Onboard UFS storage (flashed over USB)",
          autoMount: false,
          command: "avocado provision -r dev --profile ufs",
          description:
            "Provision the dev runtime to the board's onboard UFS storage. The system image is flashed over the USB-C data connection (port 5) while the device is in EDL mode.",
          steps: [
            {
              type: "text",
              content:
                "Provisioning flashes the runtime to UFS over USB. When it completes you'll see:",
            },
            {
              type: "code",
              content: "[SUCCESS] Successfully provisioned runtime 'dev'",
            },
          ],
          recoveryMode: {
            reference: {
              url: "https://www.thundercomm.com/rubik-pi-3/en/docs/rubik-pi-3-user-manual/1.0.0-u/set-up-your-device",
              label: "RUBIK Pi 3 — Set up your device",
            },
            steps: [
              "With the board powered off, connect the USB-C data cable from the board's USB-C port (port 5) to your host.",
              "Press and hold the EDL button (port 12) on the board.",
              "While holding EDL, connect the power cable to the power input (port 10) to apply power, then release the button. The board enumerates in Qualcomm EDL (download) mode.",
            ],
            verifyCommand: "lsusb",
            verifyExpect:
              "Look for a Qualcomm device with ID 05c6:9008 (Emergency Download mode) — this confirms the board is ready to flash.",
          },
          bootInstructions:
            "Disconnect the USB-C data cable (port 5), leave the power input (port 10) connected, and power-cycle the board. It boots Avocado OS from the onboard UFS storage.",
          bootNote:
            "Now that provisioning has succeeded, connect the Micro-USB cable to the debug port (port 2) for the UART console (see Serial Console above). The root user is passwordless in the dev runtime.",
        },
      ],
    },
    serial: {
      onboard: true,
      baud: 115200,
      command: "tio -b 115200 /dev/ttyUSB0",
      description:
        "The Rubik Pi 3 exposes its debug UART over the onboard Micro-USB port (port 2) — no TTL adapter is required. Connect the Micro-USB cable to your host only after provisioning completes (leave it disconnected while flashing). The host then enumerates a USB serial device for the console.",
    },
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/qualcomm/rubik-pi-3",
  },
  rb3gen2: {
    name: "Qualcomm RB3 Gen 2",
    target: "rb3gen2",
    releases: {
      "2026": "supported",
    },
    category: "physical",
    description:
      "The RB3 Gen 2 is provisioned by flashing the kit's onboard UFS storage over USB while the SoC is in Qualcomm EDL (Emergency Download) mode. One target backs the core kit and both mezzanines. The Vision Kit is validated on hardware; core and Industrial Kit packages are published but not yet hardware-validated.",
    configuration: {
      description:
        "After initializing, update these settings in avocado.yaml before installing. Use rb3gen2-vision for the Vision Kit or rb3gen2-industrial for the Industrial Kit; omit default_target_board for the core kit. All three use the 2026 next feed.",
      yaml: "default_target: rb3gen2\ndefault_target_board: rb3gen2-vision # or rb3gen2-industrial; omit for the core kit\n\ndistro:\n  release: 2026\n  channel: next",
    },
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "Qualcomm RB3 Gen 2 Development Kit (core kit, Vision Kit or Industrial Kit) with its power supply",
        "USB-C data cable from the kit's USB-C port to your host for flashing",
      ],
      options: [
        {
          id: "ufs",
          label: "UFS (EDL)",
          profile: "ufs",
          media: "Onboard UFS storage (flashed over USB)",
          autoMount: false,
          command: "avocado provision -r dev --profile ufs",
          description:
            "Provision the dev runtime to the kit's onboard UFS storage. The system image is flashed over the USB-C data connection while the SoC is in EDL mode. The ufs profile is required: it mounts the host's USB bus into the provisioning container.",
          steps: [
            {
              type: "text",
              content:
                "Provisioning flashes the runtime to UFS over USB. When it completes you'll see:",
            },
            {
              type: "code",
              content: "[SUCCESS] Successfully provisioned runtime 'dev'",
            },
          ],
          recoveryMode: {
            reference: {
              url: "https://www.qualcomm.com/developer/hardware/rb3-gen-2-development-kit",
              label: "Qualcomm RB3 Gen 2 Development Kit",
            },
            steps: [
              "With the USB-C data cable connected to your host, put the kit into Qualcomm EDL mode following the RB3 Gen 2 documentation linked above.",
            ],
            verifyCommand: "lsusb",
            verifyExpect:
              "Look for a Qualcomm device with ID 05c6:9008 (Emergency Download mode). 05c6:900e is the SoC's dload/ramdump mode, not EDL — power-cycle the board into EDL again if you see it.",
          },
          bootInstructions:
            "Disconnect the USB-C data cable and power-cycle the kit. It boots Avocado OS from the onboard UFS storage.",
          bootNote:
            "The root user is passwordless in the dev runtime, and the avocado-ext-sshd-dev extension in the generated project brings up SSH.",
        },
      ],
    },
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/qualcomm/rb3-gen-2",
  },
  "qemux86-64": {
    name: "QEMU x86-64",
    target: "qemux86-64",
    releases: {
      "2024": "supported",
    },
    category: "virtual",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: ["8GB available disk space"],
      options: [
        {
          id: "vm",
          label: "Virtual machine",
          profile: null,
          media: null,
          autoMount: false,
          command: "avocado provision -r dev",
          bootInstructions: "Launch the VM with avocado sdk run -iE vm dev",
        },
      ],
    },
    serial: null,
    gettingStartedUrl: "/developer-reference/getting-started/qemu",
    hardwareUrl: null,
  },
  "jetson-orin-nano-devkit": {
    name: "NVIDIA Jetson Orin Nano",
    target: "jetson-orin-nano-devkit",
    releases: {
      "2024": "supported",
      "2026": "in-progress",
    },
    category: "tegraflash",
    description:
      "The Jetson is provisioned over USB using NVIDIA's tegraflash tooling, which runs inside the Avocado SDK container.",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "NVIDIA Jetson Orin Nano Developer Kit",
        "NVMe SSD (M.2 2280 form factor)",
        "16 GB available disk space",
        "USB-C cable for provisioning (host USB to Jetson USB-C)",
      ],
      options: [
        {
          id: "tegraflash",
          label: "USB recovery (tegraflash)",
          profile: "tegraflash",
          media: "NVMe SSD (M.2 2280)",
          autoMount: false,
          command: "avocado provision -r dev --profile tegraflash",
          description:
            "Provision the dev runtime using the tegraflash profile. This builds the system image and flashes it to the Jetson over USB.",
          steps: [
            {
              type: "text",
              content: "The procedure advances through several steps:",
            },
            {
              type: "code",
              content:
                "== Step 1: Signing binaries ==\n...\n== Step 2: Boot Jetson via RCM ==\n...\n== Step 3: Sending flash sequence commands ==\n...",
            },
            {
              type: "text",
              content: "When provisioning completes:",
            },
            {
              type: "code",
              content: "[SUCCESS] Successfully provisioned runtime 'dev'",
            },
          ],
          recoveryMode: {
            steps: [
              "With the device powered off, short the FC REC pin to GND using a jumper",
              "Connect the USB-C cable from the Jetson to your host machine",
              "Apply power to the Jetson",
            ],
            verifyCommand: "lsusb",
            verifyExpect:
              "Look for an entry containing NVIDIA Corp. APX — this confirms the device is in recovery mode.",
          },
          bootSteps: [
            "Remove power from the Jetson",
            "Remove the jumper shorting FC REC to GND",
            "Remove the USB-C cable",
            "If you attached a serial console adapter, leave it connected",
            "Apply power",
          ],
          bootNote:
            "The device will boot with the provisioned system. The root user has an empty password — log in over the serial console (if connected) or via SSH once the device is on the network.",
        },
      ],
    },
    serial: {
      baud: 115200,
      voltage: "3.3V",
      command: "tio -b 115200 /dev/ttyUSB0",
      gpio: [
        {
          color: "#cccc00",
          label: "yellow",
          pin: "FC REC",
          to: "GND",
          note: "recovery mode",
        },
        {
          color: "#000000",
          label: "black",
          pin: "GND",
          to: "adapter UART GND",
        },
        {
          color: "#00aa00",
          label: "green",
          pin: "UART TXD",
          to: "adapter UART RX",
        },
        {
          color: "#0000cc",
          label: "blue",
          pin: "UART RXD",
          to: "adapter UART TX",
        },
      ],
    },
    gettingStartedUrl: "/developer-reference/getting-started/jetson",
    hardwareUrl: "/hardware/nvidia/jetson-orin-nano-developer-kit",
  },
  "jetson-agx-orin-devkit": {
    name: "NVIDIA Jetson AGX Orin",
    target: "jetson-agx-orin-devkit",
    releases: {
      "2024": "supported",
      "2026": "in-progress",
    },
    category: "tegraflash",
    description:
      "The Jetson is provisioned over USB using NVIDIA's tegraflash tooling, which runs inside the Avocado SDK container.",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "NVIDIA Jetson AGX Orin Developer Kit",
        "NVMe SSD (M.2 2280 form factor)",
        "16 GB available disk space",
        "USB-C cable (host to Jetson, for flashing)",
      ],
      options: [
        {
          id: "tegraflash",
          label: "USB recovery (tegraflash)",
          profile: "tegraflash",
          media: "NVMe SSD (M.2 2280)",
          autoMount: false,
          command: "avocado provision -r dev --profile tegraflash",
          description:
            "Provision the dev runtime using the tegraflash profile. This builds the system image and flashes it to the Jetson over USB.",
          steps: [
            {
              type: "text",
              content: "The procedure advances through several steps:",
            },
            {
              type: "code",
              content:
                "== Step 1: Signing binaries ==\n...\n== Step 2: Boot Jetson via RCM ==\n...\n== Step 3: Sending flash sequence commands ==\n...",
            },
            {
              type: "text",
              content: "When provisioning completes:",
            },
            {
              type: "code",
              content: "[SUCCESS] Successfully provisioned runtime 'dev'",
            },
          ],
          recoveryMode: {
            reference: {
              label: "NVIDIA Jetson AGX Orin Developer Kit hardware layout",
              url: "https://docs.nvidia.com/jetson/agx-orin-devkit/user-guide/1.0/hardware-layout.html",
            },
            steps: [
              {
                text: "Connect a USB-C cable from the Jetson to your host for flashing.",
              },
              {
                text: "Press and hold both the Reset button and the Force Recovery button on the back of the Jetson.",
              },
              {
                text: "Release the Reset button. Wait 2-3 seconds, then release the Force Recovery button.",
              },
            ],
            verifyCommand: "lsusb",
            verifyExpect:
              "Look for an entry containing NVIDIA Corp. APX — this confirms the device is in recovery mode.",
          },
          bootSteps: [
            "Remove power from the Jetson",
            "Remove the USB-C cable",
            "If you want a serial console, leave the Micro USB cable connected",
            "Apply power",
          ],
          bootNote:
            "The device will boot with the provisioned system. The root user has an empty password — log in over the serial console (if connected) or via SSH once the device is on the network.",
        },
      ],
    },
    serial: {
      onboard: true,
      kind: "onboard-micro-usb",
      baud: 115200,
      command: "tio -b 115200 /dev/ttyUSB0",
    },
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/nvidia/jetson-agx-orin",
  },
  "imx8mp-var-dart": {
    name: "Variscite DART-MX8M-PLUS",
    target: "imx8mp-var-dart",
    releases: {
      "2024": "supported",
      "2026": "in-progress",
    },
    board: "variscite-sonata",
    category: "sd",
    description:
      "The Variscite DART-MX8M-PLUS is an industrial i.MX 8M Plus SoM. It provisions to an SD card or to onboard eMMC over USB (UUU), selected with the carrier's SW7 boot switch.",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "Variscite DART-MX8M-PLUS SoM on a Variscite carrier board",
      ],
      options: [
        {
          id: "sd",
          label: "SD card",
          profile: "sd",
          media: "microSD card (8GB+)",
          autoMount: true,
          prerequisites: ["microSD card (8GB+)", "SD card reader"],
          description:
            "Set the carrier's SW7 switch to external (boot from external media) and insert the SD card, then provision the dev runtime with the sd profile:",
          command: "avocado provision -r dev --profile sd",
          bootInstructions:
            "With SW7 set to external and the SD card inserted, power on the board — it boots Avocado OS from the SD card.",
        },
        {
          id: "uuu-emmc",
          label: "eMMC (UUU)",
          profile: "uuu-emmc",
          media: "Onboard eMMC (flashed over USB)",
          autoMount: false,
          prerequisites: [
            "USB-C cable (board to host)",
            "Micro USB cable for the debug port",
          ],
          description:
            "Flash the onboard eMMC over USB with the uuu-emmc profile. First put the board into serial download mode: connect the USB-C cable and the micro USB debug port to your host, set SW7 to external, and power on the board with no SD card in the slot — it comes up in serial download (UUU) mode. Then provision:",
          command: "avocado provision -r dev --profile uuu-emmc",
          steps: [
            {
              type: "text",
              content:
                "After programming completes, set SW7 back to internal so the board boots from the onboard eMMC.",
            },
          ],
          bootInstructions:
            "With SW7 set to internal, power-cycle the board — it boots Avocado OS from the onboard eMMC.",
        },
      ],
    },
    serial: {
      onboard: true,
      baud: 115200,
      command: "tio -b 115200 /dev/ttyUSB0",
      description:
        "The Variscite carrier exposes a debug UART console over its onboard micro USB port — no separate TTL adapter is required. Connect the micro USB debug port to your host and open the serial device it enumerates.",
    },
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/variscite/dart-mx8m-plus",
  },
  "ucm-imx8m-plus": {
    name: "CompuLab UCM-i.MX8M-Plus",
    target: "ucm-imx8m-plus",
    releases: {
      "2024": "supported",
      "2026": "in-progress",
    },
    category: "sd",
    description:
      "The CompuLab UCM-i.MX8M-Plus is an ultra-compact (28 x 38 mm) i.MX 8M Plus Computer-on-Module for space- and power-constrained edge-AI designs.",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "CompuLab UCM-i.MX8M-Plus on a compatible carrier board",
        "microSD card (8GB+)",
        "SD card reader",
      ],
      options: [
        {
          id: "sd",
          label: "SD card",
          profile: "sd",
          media: "microSD card (8GB+)",
          autoMount: true,
          command: "avocado provision -r dev --profile sd",
          bootInstructions:
            "Insert the SD card into the carrier and apply power.",
        },
      ],
    },
    serial: {
      baud: 115200,
      voltage: "3.3V",
      command: "tio -b 115200 /dev/ttyUSB0",
    },
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/compulab/ucm-imx8m-plus",
  },
  "iot-gate-imx8plus": {
    name: "CompuLab IOT-GATE-iMX8PLUS",
    target: "ucm-imx8m-plus",
    releases: {
      "2024": "supported",
      "2026": "in-progress",
    },
    category: "sd",
    description:
      "The CompuLab IOT-GATE-iMX8PLUS is a fanless industrial IoT gateway built on the UCM-i.MX8M-Plus SOM, with cellular, GPS, CAN, and an optional M.2 TPM on the carrier. Builds the same ucm-imx8m-plus target as the SOM, plus a carrier extension for the gateway peripherals.",
    configuration: {
      description:
        "Add the gateway carrier extension so the dev runtime includes its cellular, GPS, and CAN support:",
      yaml: "extensions:\n  avocado-bsp-iot-gate-imx8plus:\n    source:\n      type: package\n      version: '*'\n\nruntimes:\n  dev:\n    extensions:\n      - avocado-bsp-iot-gate-imx8plus",
    },
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "CompuLab IOT-GATE-iMX8PLUS",
        "microSD card (8GB+)",
        "SD card reader",
      ],
      options: [
        {
          id: "sd",
          label: "SD card",
          profile: "sd",
          media: "microSD card (8GB+)",
          autoMount: true,
          command: "avocado provision -r dev --profile sd",
          bootInstructions:
            "Insert the SD card into the gateway and apply power. Confirm the gateway's boot-mode selection in CompuLab's documentation first - this has not been verified against Avocado OS on this specific carrier.",
        },
      ],
    },
    serial: {
      baud: 115200,
      voltage: "3.3V",
      command: "tio -b 115200 /dev/ttyUSB0",
    },
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/compulab/iot-gate-imx8plus",
  },
  raspberrypi5: {
    name: "Raspberry Pi 5",
    target: "raspberrypi5",
    releases: { "2024": "supported", "2026": "in-progress" },
    category: "sd",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "microSD card (8 GB+), or an NVMe SSD installed in the Pi",
      ],
      options: [
        {
          id: "sd",
          label: "SD card",
          profile: "sd",
          media: "microSD card (8GB+)",
          autoMount: true,
          prerequisites: ["SD card reader"],
          description:
            "Insert your SD card into a reader on your host, then run the sd profile, which writes the image directly to the SD card:",
          command: "avocado provision -r dev --profile sd",
          bootInstructions:
            "With the SD card inserted, apply power to the Raspberry Pi 5 — it boots from the card.",
        },
        {
          id: "usb",
          label: "USB (device mode)",
          profile: "usb",
          media: "SD card or NVMe SSD in the Pi (flashed in place over USB)",
          autoMount: true,
          prerequisites: ["USB-C data cable (Pi to host)"],
          description:
            "Flash the Pi's storage in place over USB, with no card reader — this also works for an NVMe SSD installed in the Pi. With the Pi powered off and the target storage in place, press and hold the power button, then connect a USB-C data cable from the Pi to your host to apply power, releasing the button once it's connected. The Pi boots into USB device mode and your host detects it as a USB mass storage device. Note that the Pi is powered over this same USB-C cable: the Pi 5 targets a 5 V/5 A (27 W) supply and most host ports deliver less, so use a data-capable USB-C cable and a host port that can source enough current (an NVMe SSD adds to the draw); if provisioning is unreliable, use the SD-card method instead. The Pi 5's status LED confirms power: it shows red in standby and turns steady green once powered with enough current — if it won't turn green, stays red, or flickers, the supply is too weak. Then provision with the usb profile:",
          command: "avocado provision -r dev --profile usb",
          bootInstructions:
            "Disconnect the USB-C data cable, then apply power to the Raspberry Pi 5 — it boots from its storage.",
        },
      ],
    },
    serial: {
      baud: 115200,
      voltage: "3.3V",
      command: "tio -b 115200 /dev/ttyUSB0",
    },
    gettingStartedUrl: "/developer-reference/getting-started/raspberry-pi",
    hardwareUrl: "/hardware/raspberry-pi/raspberry-pi-5",
  },
  raspberrypi4: {
    name: "Raspberry Pi 4 Model B",
    target: "raspberrypi4",
    releases: { "2024": "supported", "2026": "in-progress" },
    category: "sd",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: ["microSD card (8GB+)", "SD card reader"],
      options: [
        {
          id: "sd",
          label: "SD card",
          profile: "sd",
          media: "microSD card (8GB+)",
          autoMount: true,
          command: "avocado provision -r dev --profile sd",
          bootInstructions:
            "Insert the SD card into the device and apply power.",
        },
      ],
    },
    serial: {
      baud: 115200,
      voltage: "3.3V",
      command: "tio -b 115200 /dev/ttyUSB0",
    },
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/raspberry-pi/raspberry-pi-4-model-b",
  },
  fr201: {
    name: "OnLogic FR201",
    target: "fr201",
    releases: { "2024": "supported", "2026": "in-progress" },
    category: "usb",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: ["USB drive"],
      options: [
        {
          id: "usb",
          label: "USB drive",
          profile: "usb",
          media: "USB drive",
          autoMount: true,
          command: "avocado provision -r dev --profile usb",
          bootInstructions:
            "Insert the USB drive into the device and apply power.",
        },
      ],
    },
    serial: {
      baud: 115200,
      voltage: "3.3V",
      command: "tio -b 115200 /dev/ttyUSB0",
    },
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/onlogic/fr201",
  },
  "intel-x86-64-v3": {
    name: "Intel x86-64-v3",
    target: "intel-x86-64-v3",
    releases: { "2024": "supported", "2026": "in-progress" },
    category: "usb",
    provisioning: {
      hostOs: ["macOS", "Linux"],
      prerequisites: [
        "USB drive",
        "UEFI boot support (Legacy BIOS not supported)",
      ],
      options: [
        {
          id: "usb",
          label: "USB drive",
          profile: "usb",
          media: "USB drive",
          autoMount: true,
          command: "avocado provision -r dev --profile usb",
          bootInstructions:
            "Insert the USB drive into the device and boot from USB via UEFI.",
        },
      ],
    },
    serial: null,
    gettingStartedUrl: "/developer-reference/getting-started/any-target",
    hardwareUrl: "/hardware/intel/x86-64-v3",
  },
};

export const DEVICES = [
  {
    name: "Advantech ICAM-540",
    target: "icam-540",
    board: "",
    url: "/hardware/advantech/icam-540",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Advantech MIC-712-OX",
    target: "jetson-orin-nx",
    board: "mic-712-ox-16gb",
    url: "/hardware/advantech/mic-712-ox",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Advantech MIC-733-AO5A1",
    target: "jetson-agx-orin-devkit",
    board: "mic-733-ao5a1",
    url: "/hardware/advantech/mic-733-ao",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Advantech MIC-733-AO6A1",
    target: "jetson-agx-orin-devkit",
    board: "mic-733-ao6a1",
    url: "/hardware/advantech/mic-733-ao",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "CompuLab UCM-i.MX8M-Plus",
    target: "ucm-imx8m-plus",
    board: "",
    url: "/hardware/compulab/ucm-imx8m-plus",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "CompuLab IOT-GATE-iMX8PLUS",
    target: "ucm-imx8m-plus",
    board: "",
    url: "/hardware/compulab/iot-gate-imx8plus",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Grinn AstraSOM-1680",
    target: "grinn-astra-1680-sbc",
    board: "",
    url: "/hardware/grinn/astrasom-1680",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Intel x86-64-v2",
    target: "intel-x86-64-v2",
    board: "",
    url: "/hardware/intel/x86-64-v2",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Intel x86-64-v3",
    target: "intel-x86-64-v3",
    board: "",
    url: "/hardware/intel/x86-64-v3",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "NVIDIA Jetson AGX Orin Developer Kit",
    target: "jetson-agx-orin-devkit",
    board: "",
    url: "/hardware/nvidia/jetson-agx-orin",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "NVIDIA Jetson AGX Thor",
    target: "jetson-agx-thor",
    board: "",
    url: "/hardware/nvidia/jetson-agx-thor",
    lts: {
      "2024": "none",
      "2026": "supported",
    },
  },
  {
    name: "NVIDIA Jetson Orin NX",
    target: "jetson-orin-nx",
    board: "",
    url: "/hardware/nvidia/jetson-orin-nx",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "NVIDIA Jetson Orin Nano Developer Kit",
    target: "jetson-orin-nano-devkit",
    board: "",
    url: "/hardware/nvidia/jetson-orin-nano-developer-kit",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "NXP FRDM i.MX 91",
    target: "imx91-frdm",
    board: "",
    url: "/hardware/nxp/frdm-imx-91",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "NXP i.MX 8MP EVK",
    target: "imx8mp-evk",
    board: "",
    url: "/hardware/nxp/imx8mp",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "NXP i.MX 93 EVK",
    target: "imx93-evk",
    board: "",
    url: "/hardware/nxp/imx93-evk",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "NXP i.MX 93 FRDM SBC",
    target: "imx93-frdm",
    board: "",
    url: "/hardware/nxp/frdm-imx-93",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "OnLogic FR201",
    target: "fr201",
    board: "",
    url: "/hardware/onlogic/fr201",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Qualcomm RB3 Gen 2",
    target: "rb3gen2",
    board: "",
    url: "/hardware/qualcomm/rb3-gen-2",
    lts: {
      "2024": "none",
      "2026": "supported",
    },
  },
  {
    name: "Qualcomm RB3 Gen 2 Vision Kit",
    target: "rb3gen2",
    board: "rb3gen2-vision",
    url: "/hardware/qualcomm/rb3-gen-2",
    lts: {
      "2024": "none",
      "2026": "supported",
    },
  },
  {
    name: "Qualcomm RB3 Gen 2 Industrial Kit",
    target: "rb3gen2",
    board: "rb3gen2-industrial",
    url: "/hardware/qualcomm/rb3-gen-2",
    lts: {
      "2024": "none",
      "2026": "supported",
    },
  },
  {
    name: "Raspberry Pi 4 Model B",
    target: "raspberrypi4",
    board: "",
    url: "/hardware/raspberry-pi/raspberry-pi-4-model-b",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Raspberry Pi 5",
    target: "raspberrypi5",
    board: "",
    url: "/hardware/raspberry-pi/raspberry-pi-5",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Raspberry Pi Zero 2 W",
    target: "raspberrypi0-2w",
    board: "",
    url: "/hardware/raspberry-pi/raspberry-pi-zero-2-w",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Seeed reTerminal",
    target: "reterminal",
    board: "",
    url: "/hardware/seeed/reterminal",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Seeed reTerminal DM",
    target: "reterminal-dm",
    board: "",
    url: "/hardware/seeed/reterminal-dm",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "SolidRun HummingBoard RZ/V2N AIOT",
    target: "rzv2n-sr-som",
    board: "",
    url: "/hardware/solidrun/hummingboard-rz-v2n-aiot",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "STMicroelectronics STM32MP257F-DK",
    target: "stm32mp257f-dk",
    board: "",
    url: "/hardware/stmicroelectronics/stm32mp257f-dk",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Thundercomm Rubik Pi 3",
    target: "rubikpi3",
    board: "",
    url: "/hardware/qualcomm/rubik-pi-3",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "Variscite DART-MX8M-PLUS",
    target: "imx8mp-var-dart",
    board: "variscite-sonata",
    url: "/hardware/variscite/dart-mx8m-plus",
    lts: {
      "2024": "supported",
      "2026": "in-progress",
    },
  },
  {
    name: "QEMU ARM",
    target: "qemuarm64",
    board: "",
    url: "/developer-reference/getting-started/qemu",
    lts: {
      "2024": "supported",
      "2026": "supported",
    },
  },
  {
    name: "QEMU x86-64",
    target: "qemux86-64",
    board: "",
    url: "/developer-reference/getting-started/qemu",
    lts: {
      "2024": "supported",
      "2026": "supported",
    },
  },
];

// Live feed target slugs on 2026-10-09.
export const FEED_2024_EDGE = [
  "armv8_2a",
  "armv8a",
  "armv8a_tegra",
  "armv8a_tegra234",
  "core2_64",
  "cortexa53",
  "cortexa53_crypto",
  "cortexa53_crypto_mx8mp",
  "cortexa55",
  "cortexa55_mx91",
  "cortexa55_mx93",
  "cortexa57",
  "cortexa72",
  "cortexa73",
  "cortexa76",
  "fr202",
  "grinn-astra-1680-sbc",
  "icam-540",
  "imx8mp-evk",
  "imx8mp-var-dart",
  "imx91-frdm",
  "imx93-evk",
  "imx93-frdm",
  "imx95-frdm",
  "intel-x86-64-v2",
  "intel-x86-64-v3",
  "jetson-agx-orin-devkit",
  "jetson-orin-nano-devkit",
  "jetson-orin-nx",
  "noarch",
  "qcm6490",
  "qemuarm64",
  "qemux86-64",
  "raspberrypi0-2w",
  "raspberrypi4",
  "raspberrypi5",
  "reterminal",
  "reterminal-dm",
  "rubikpi3",
  "rzv2n-sr-som",
  "ucm-imx8m-plus",
  "x86_64_v2",
  "x86_64_v3",
];
export const FEED_2026_NEXT = [
  "imx8mp-evk",
  "imx91-frdm",
  "imx93-evk",
  "imx93-frdm",
  "imx95-frdm",
  "jetson-agx-orin",
  "jetson-agx-thor",
  "jetson-orin-nano",
  "jetson-orin-nx",
  "qemuarm64",
  "qemux86-64",
  "raspberrypi4",
  "raspberrypi5",
  "rb3gen2",
  "rubikpi3",
];

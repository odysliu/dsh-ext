// M5Stack StopWatch × DeepSeek Harness: the watch half of stopwatch-bridge.
//
// Boots, joins WiFi, finds the DSH host on the LAN, and mirrors permission
// prompts: blink + whale + chime, then a tap answers the request.

#include <M5Unified.h>

#include "src/config.h"
#include "src/link.h"
#include "src/ui.h"

// `link` collides with POSIX link(2) from <unistd.h>, so use g-prefixed globals.
Link gLink;
UI gUi;

void setup() {
  auto cfg = M5.config();
  cfg.internal_imu = false;
  cfg.internal_mic = true;  // voice input needs the ES8311 capture path
  cfg.internal_rtc = false;
  cfg.internal_spk = true;
  M5.begin(cfg);

  M5.Display.setRotation(0);
  M5.Display.setBrightness(STOPWATCH_BRIGHTNESS_IDLE);
  M5.Speaker.setVolume(140);

  gUi.begin(&gLink);
  gLink.begin(&gUi);
}

void loop() {
  M5.update();
  gLink.loop();
  gUi.loop();
  delay(1);
}

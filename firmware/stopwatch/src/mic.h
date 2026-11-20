/** Microphone capture at the rate the speech provider expects (16 kHz mono). */

#pragma once

#include <Arduino.h>

class MicCapture {
 public:
  /** Open the ES8311 input path through M5Unified. */
  bool begin();

  /**
   * Read one block of samples.
   * @param buffer destination (int16 mono)
   * @param samples how many samples to wait for (512 ≈ 32 ms at 16 kHz)
   * @returns samples actually written, 0 on failure
   */
  int read(int16_t* buffer, int samples);

  /** Close the input path. */
  void end();
};

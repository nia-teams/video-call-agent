// Exercise the configured upstream plugin in-process before system installation.
#include "DriverConfig.h"
#include "vendor/BlackHole.c"
#include <assert.h>
#include <stdio.h>

static UInt32 streamCount(AudioObjectID device, AudioObjectPropertyScope scope) {
    AudioObjectPropertyAddress address = { kAudioDevicePropertyStreams, scope, 0 };
    UInt32 bytes = 0;
    assert(BlackHole_GetDevicePropertyDataSize(gAudioServerPlugInDriverRef, device, 0, &address, 0, NULL, &bytes) == noErr);
    return bytes / sizeof(AudioObjectID);
}
int main(void) {
    assert(streamCount(kObjectID_Device, kAudioObjectPropertyScopeInput) == 0);
    assert(streamCount(kObjectID_Device, kAudioObjectPropertyScopeOutput) == 1);
    assert(streamCount(kObjectID_Device2, kAudioObjectPropertyScopeInput) == 1);
    assert(streamCount(kObjectID_Device2, kAudioObjectPropertyScopeOutput) == 0);
    assert(CFEqual(get_device_uid(), CFSTR("NodeAudioBridge_Send_UID")));
    assert(CFEqual(get_device2_uid(), CFSTR("NodeAudioBridge_Mic_UID")));
    assert(BlackHole_Create(NULL, kAudioServerPlugInTypeUUID) == gAudioServerPlugInDriverRef);
    AudioObjectPropertyAddress related = { kAudioDevicePropertyRelatedDevices, kAudioObjectPropertyScopeGlobal, 0 };
    AudioObjectID value = 0; UInt32 bytes = 0;
    assert(BlackHole_GetDevicePropertyData(gAudioServerPlugInDriverRef, kObjectID_Device2, 0, &related, 0, NULL, sizeof(value), &bytes, &value) == noErr);
    assert(bytes == sizeof(value) && value == kObjectID_Device2);
    assert(BlackHole_StartIO(gAudioServerPlugInDriverRef, kObjectID_Device, 1) == noErr);
    assert(BlackHole_StartIO(gAudioServerPlugInDriverRef, kObjectID_Device2, 2) == noErr);
    enum { frames = 256, samples = frames * 2 };
    float source[samples], received[samples];
    for (int i = 0; i < samples; ++i) source[i] = sinf((float)i * 0.1f) * 0.4f;
    AudioServerPlugInIOCycleInfo cycle = { 0 };
    // Straddle the circular-buffer boundary to exercise both copy sections.
    cycle.mOutputTime.mSampleTime = kRing_Buffer_Frame_Size - 128;
    cycle.mInputTime.mSampleTime = cycle.mOutputTime.mSampleTime;
    assert(BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device, kObjectID_Stream_Output, 1, kAudioServerPlugInIOOperationWriteMix, frames, &cycle, source, NULL) == noErr);
    assert(BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device2, kObjectID_Stream_Input, 2, kAudioServerPlugInIOOperationReadInput, frames, &cycle, received, NULL) == noErr);
    for (int i = 0; i < samples; ++i) assert(fabsf(source[i] - received[i]) < 1e-6f);
    gMute_Master_Value = true;
    assert(BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device2, kObjectID_Stream_Input, 2, kAudioServerPlugInIOOperationReadInput, frames, &cycle, received, NULL) == noErr);
    for (int i = 0; i < samples; ++i) assert(received[i] == 0);
    assert(BlackHole_StopIO(gAudioServerPlugInDriverRef, kObjectID_Device2, 2) == noErr);
    assert(BlackHole_StopIO(gAudioServerPlugInDriverRef, kObjectID_Device, 1) == noErr);
    puts("PASS: separate input/output devices, unique UIDs, independent related-device list, stereo PCM transfer across ring wrap, mute, cleanup");
}

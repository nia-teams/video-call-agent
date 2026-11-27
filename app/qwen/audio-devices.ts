import { isExplicitDevice, isVirtualOutput } from '../studio/audio-devices';

export function qwenOutput(devices: MediaDeviceInfo[], current = '') {
  const outputs = devices.filter(d => d.kind === 'audiooutput' && isExplicitDevice(d) && isVirtualOutput(d.label));
  return outputs.find(d => d.deviceId === current)?.deviceId
    ?? outputs.find(d => /Node\s*Audio\s*Send/i.test(d.label))?.deviceId
    ?? '';
}

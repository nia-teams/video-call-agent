export const isExplicitDevice=(d:Pick<MediaDeviceInfo,"deviceId">)=>!!d.deviceId && d.deviceId!=="default" && d.deviceId!=="communications";
export const isVirtualOutput=(label:string)=>/Node Audio Send|BlackHole/i.test(label);
export const isVirtualInput=(label:string)=>/Node Virtual Mic|BlackHole/i.test(label);
export function virtualInput(devices:MediaDeviceInfo[]){
  return devices.find(d=>d.kind==='audioinput'&&isExplicitDevice(d)&&/Node Virtual Mic/i.test(d.label))
    ||devices.find(d=>d.kind==='audioinput'&&isExplicitDevice(d)&&/BlackHole/i.test(d.label));
}

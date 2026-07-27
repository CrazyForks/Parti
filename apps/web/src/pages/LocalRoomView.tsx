import { useEffect, useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { PlusIcon } from 'lucide-react';
import type { RoomClientPort } from '@parti/client-sdk';
import { type RoomPackage } from '@parti/room-packager';
import { ROOM_FRAME_GRID_AREAS, RoomFrame, type RoomFrameGridKey } from '../components/RoomFrame';
import { DevTools } from '../components/DevTools';
import { LocalRoomSession } from '../lib/LocalRoomSession';
import { loadRoomSnapshot } from '../lib/customRooms';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type DeviceKind = 'desktop' | 'tablet' | 'mobile';

/**
 * 与首屏的 Host / Alice / Bob 完全相同的画布占用尺寸。
 * 追加设备从第 13 行起自动密集排布，因而不会压缩或改变任何设备型号的测试尺寸。
 */
const DEVICE_GRID_SPANS: Record<DeviceKind, CSSProperties> = {
  desktop: { gridColumn: 'span 7 / span 7', gridRow: 'span 7 / span 7' },
  tablet: { gridColumn: 'span 10 / span 10', gridRow: 'span 5 / span 5' },
  mobile: { gridColumn: 'span 3 / span 3', gridRow: 'span 7 / span 7' },
};

interface Seat {
  id: string;
  name: string;
  label: string;
  role: string;
  port: RoomClientPort;
  device: DeviceKind;
  gridKey?: RoomFrameGridKey;
}

interface Loaded {
  session: LocalRoomSession;
  pkg: RoomPackage;
  seats: Seat[];
}

/** 本地多人预览：一个 Host 和可按需增加的虚拟玩家，全部经真实 worker / iframe 沙箱跑通。 */
export function LocalRoomView({ roomId }: { roomId: string }) {
  const intl = useIntl();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [deviceKind, setDeviceKind] = useState<DeviceKind>('mobile');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let session: LocalRoomSession | undefined;

    (async () => {
      const pkg = await loadRoomSnapshot(roomId);
      session = await LocalRoomSession.create(pkg);
      const hostPort = session.hostPort();
      const p1 = await session.addPlayer('Alice');
      const p2 = await session.addPlayer('Bob');
      if (cancelled) {
        session.dispose();
        return;
      }
      setLoaded({
        session,
        pkg,
        seats: [
          {
            id: 'host',
            name: intl.formatMessage({ id: 'local.seat.host' }),
            label: `${intl.formatMessage({ id: 'local.seat.host' })} · ${intl.formatMessage({ id: 'local.device.desktop' })}`,
            role: 'host', port: hostPort,
            device: 'desktop',
            gridKey: 'desktop',
          },
          {
            id: 'alice',
            name: 'Alice',
            label: `${intl.formatMessage({ id: 'local.seat.alice' })} · ${intl.formatMessage({ id: 'local.device.tablet' })}`,
            role: 'player', port: p1,
            device: 'tablet',
            gridKey: 'tablet',
          },
          {
            id: 'bob',
            name: 'Bob',
            label: `${intl.formatMessage({ id: 'local.seat.bob' })} · ${intl.formatMessage({ id: 'local.device.mobile' })}`,
            role: 'player', port: p2,
            device: 'mobile',
            gridKey: 'phone',
          },
        ],
      });
    })().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      cancelled = true;
      session?.dispose();
    };
  }, [intl, roomId]);

  if (error) {
    return (
      <Card className="mx-auto max-w-lg p-6 text-destructive">
        {intl.formatMessage({ id: 'local.loadFailed' }, { error })}
      </Card>
    );
  }
  if (!loaded) {
    return <div className="p-[22px] text-center text-[13px] text-muted-foreground"><FormattedMessage id="local.loading" /></div>;
  }

  const active = loaded;
  const maxPlayers = active.pkg.manifest.room?.maxPlayers;
  const atCapacity = maxPlayers !== undefined && active.seats.length >= maxPlayers;

  function deviceLabel(kind: DeviceKind): string {
    return intl.formatMessage({ id: `local.device.${kind}` });
  }

  function openAddDialog(): void {
    if (atCapacity) return;
    setDeviceName(intl.formatMessage({ id: 'local.add.defaultName' }, { number: active.seats.length + 1 }));
    setDeviceKind('mobile');
    setAddError(null);
    setAddDialogOpen(true);
  }

  async function addDevice(): Promise<void> {
    const name = deviceName.trim().replace(/\s+/g, ' ');
    if (!name) {
      setAddError(intl.formatMessage({ id: 'local.add.nameRequired' }));
      return;
    }
    if (active.seats.some((seat) => seat.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      setAddError(intl.formatMessage({ id: 'local.add.nameTaken' }));
      return;
    }
    if (atCapacity) {
      setAddError(intl.formatMessage({ id: 'local.add.capacityReached' }));
      return;
    }

    setAdding(true);
    setAddError(null);
    try {
      const port = await active.session.addPlayer(name);
      setLoaded((current) => {
        if (!current || current.session !== active.session) return current;
        const id = `virtual-${current.seats.length}`;
        return {
          ...current,
          seats: [...current.seats, {
            id,
            name,
            label: `${name} · ${deviceLabel(deviceKind)}`,
            role: 'player',
            port,
            device: deviceKind,
          }],
        };
      });
      setAddDialogOpen(false);
    } catch (reason) {
      setAddError(intl.formatMessage(
        { id: 'local.add.failed' },
        { error: reason instanceof Error ? reason.message : String(reason) },
      ));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="mx-auto w-[min(1240px,100%)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">
          {intl.formatMessage({ id: 'local.title' }, { name: loaded.pkg.manifest.name })}
        </h2>
        <div className="flex items-center gap-3">
          {maxPlayers !== undefined && (
            <span className="text-xs text-muted-foreground">
              {intl.formatMessage({ id: 'local.add.capacity' }, { current: loaded.seats.length, max: maxPlayers })}
            </span>
          )}
          <Button type="button" className="gap-2" onClick={openAddDialog} disabled={atCapacity}>
            <PlusIcon />
            <FormattedMessage id="local.add.button" />
          </Button>
        </div>
      </div>
      <div
        className="mb-4 grid w-full grid-flow-row-dense grid-cols-10 gap-2"
        style={{
          gridAutoRows: 'calc((min(calc(160dvh - 200px), 1600px) - 88px) / 12)',
        }}
      >
        {active.seats.map((seat) => (
          <RoomFrame
            key={seat.id}
            pkg={active.pkg}
            port={seat.port}
            label={seat.label}
            role={seat.role}
            style={seat.gridKey ? ROOM_FRAME_GRID_AREAS[seat.gridKey] : DEVICE_GRID_SPANS[seat.device]}
            viewport={{ fill: true }}
          />
        ))}
      </div>
      <DevTools
        host={loaded.session.host}
        packageHash={active.pkg.packageHash}
        transportName="local"
      />
      <Dialog open={addDialogOpen} onOpenChange={(open) => { if (!adding) setAddDialogOpen(open); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle><FormattedMessage id="local.add.title" /></DialogTitle>
            <DialogDescription><FormattedMessage id="local.add.description" /></DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <label className="grid gap-2 text-sm font-medium" htmlFor="local-device-name">
              <FormattedMessage id="local.add.nameLabel" />
              <Input
                id="local-device-name"
                maxLength={24}
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void addDevice(); }}
                disabled={adding}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium" htmlFor="local-device-kind">
              <FormattedMessage id="local.add.deviceLabel" />
              <Select value={deviceKind} onValueChange={(value) => setDeviceKind(value as DeviceKind)} disabled={adding}>
                <SelectTrigger id="local-device-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(DEVICE_GRID_SPANS) as DeviceKind[]).map((kind) => (
                    <SelectItem key={kind} value={kind}>{deviceLabel(kind)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {addError && <p className="text-sm text-destructive" role="alert">{addError}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={adding} onClick={() => setAddDialogOpen(false)}>
              <FormattedMessage id="local.add.cancel" />
            </Button>
            <Button type="button" disabled={adding} onClick={() => void addDevice()}>
              <FormattedMessage id="local.add.confirm" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

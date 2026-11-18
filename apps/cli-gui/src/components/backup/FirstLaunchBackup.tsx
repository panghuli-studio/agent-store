import { useEffect, useState } from 'react'
import type { InstalledItem } from '@as/types'
import { callRpc } from '../../lib/rpc'
import { useT } from '../../i18n'
import { useAppState } from '../../state/AppState'
import { useBackup } from '../../state/Backup'
import { writeLocalState } from '../../state/LocalPersistence'
import { Button } from '../ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog'

/** Runs before import, so restoring can only start with an empty library. */
export function FirstLaunchBackup() {
  const t = useT()
  const { shellDialog, setShellDialog, setNavView, setSettingsTab, installDialogOpen, installedVersion } = useAppState()
  const backup = useBackup()
  const [eligible, setEligible] = useState(false)
  const pending = shellDialog === 'first-run-backup'
  useEffect(() => {
    let active = true
    setEligible(false)
    if (pending && !installDialogOpen) {
      // A link can install something while the first-launch choice is deferred.
      void callRpc<InstalledItem[]>('list').then(items => {
        if (!active) return
        if (items.length) setShellDialog('welcome')
        else setEligible(true)
      }, () => {
        if (active) setShellDialog('welcome')
      })
    }
    return () => { active = false }
  }, [pending, installDialogOpen, installedVersion, setShellDialog])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function choose(restore: boolean) {
    if (busy || !backup) return
    setBusy(true)
    setFailed(false)
    try {
      // Save before leaving: cancellation and failed restores must not ask again.
      await writeLocalState('first-launch-backup', true)
      if (restore) {
        await writeLocalState('welcome', { seenAt: new Date().toISOString() })
        setShellDialog(null)
        setSettingsTab('backup')
        setNavView('settings')
        backup.openDialog({ kind: 'connect', mode: 'restore', firstRun: true })
      } else {
        setShellDialog('welcome')
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={pending && eligible && !installDialogOpen} onOpenChange={(open) => !open && void choose(false)}>
      <DialogContent width="md" onCloseAutoFocus={(e) => e.preventDefault()} aria-describedby="first-launch-description" onEscapeKeyDown={(e) => busy && e.preventDefault()} onPointerDownOutside={(e) => busy && e.preventDefault()}>
        <DialogBody>
          <DialogTitle>{t('bk.firstTitle')}</DialogTitle>
          <DialogDescription id="first-launch-description" className="mt-2">{t('bk.firstDescription')}</DialogDescription>
          <p className="mt-3 text-xs text-fg-3">{t('bk.firstLater')}</p>
          {failed && <p role="alert" className="mt-3 text-xs text-bad">{t('bk.firstSaveFailed')}</p>}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy || !backup} onClick={() => void choose(false)}>{t('bk.firstFresh')}</Button>
          <Button variant="primary" disabled={busy || !backup} onClick={() => void choose(true)}>{t('bk.firstRestore')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

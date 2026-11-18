import { useState } from 'react'
import { useT } from '../../i18n'
import { useAppState } from '../../state/AppState'
import { useBackup } from '../../state/Backup'
import { writeLocalState } from '../../state/LocalPersistence'
import { Button } from '../ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog'

/** Runs before import, so restoring can only start with an empty library. */
export function FirstLaunchBackup() {
  const t = useT()
  const { shellDialog, setShellDialog, setNavView, setSettingsTab } = useAppState()
  const backup = useBackup()
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
    <Dialog open={shellDialog === 'first-run-backup'} onOpenChange={(open) => !open && void choose(false)}>
      <DialogContent width="md" aria-describedby="first-launch-description" onEscapeKeyDown={(e) => busy && e.preventDefault()} onPointerDownOutside={(e) => busy && e.preventDefault()}>
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

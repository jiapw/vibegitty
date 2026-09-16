import { useUiStore } from "../store/ui";
import { CloneModal } from "./modals/CloneModal";
import { AccountsModal } from "./modals/AccountsModal";
import { SettingsModal } from "./modals/SettingsModal";
import {
  ConfirmModal,
  InputModal,
  LfsModal,
  NewBranchModal,
  NewTagModal,
  RemotesModal,
  ResetModal,
  StashModal,
} from "./modals/SimpleModals";

export function ModalHost() {
  const modal = useUiStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case "clone":
      return <CloneModal />;
    case "accounts":
      return <AccountsModal reauth={modal.reauth} />;
    case "settings":
      return <SettingsModal />;
    case "confirm":
      return <ConfirmModal spec={modal} />;
    case "input":
      return <InputModal spec={modal} />;
    case "newBranch":
      return <NewBranchModal spec={modal} />;
    case "newTag":
      return <NewTagModal spec={modal} />;
    case "stash":
      return <StashModal />;
    case "reset":
      return <ResetModal spec={modal} />;
    case "remotes":
      return <RemotesModal />;
    case "lfs":
      return <LfsModal />;
    default:
      return null;
  }
}

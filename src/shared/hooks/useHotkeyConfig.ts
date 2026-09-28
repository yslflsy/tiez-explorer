import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type HotkeyMode = "main" | "sequential" | "rich" | "search" | "screenshot";

interface UseHotkeyConfigOptions {
  hotkey: string;
  setHotkey: (val: string) => void;
  sequentialHotkey: string;
  setSequentialHotkey: (val: string) => void;
  richPasteHotkey: string;
  setRichPasteHotkey: (val: string) => void;
  searchHotkey: string;
  setSearchHotkey: (val: string) => void;
  screenshotHotkey: string;
  setScreenshotHotkey: (val: string) => void;
  sequentialMode: boolean;
  isRecording: boolean;
  setIsRecording: (val: boolean) => void;
  isRecordingSequential: boolean;
  setIsRecordingSequential: (val: boolean) => void;
  isRecordingRich: boolean;
  setIsRecordingRich: (val: boolean) => void;
  isRecordingSearch: boolean;
  setIsRecordingSearch: (val: boolean) => void;
  isRecordingScreenshot: boolean;
  setIsRecordingScreenshot: (val: boolean) => void;
  saveAppSetting: (type: string, value: string) => void;
  t: (key: string) => string;
  pushToast: (msg: string, duration?: number) => number;
}

export const useHotkeyConfig = ({
  hotkey,
  setHotkey,
  sequentialHotkey,
  setSequentialHotkey,
  richPasteHotkey,
  setRichPasteHotkey,
  searchHotkey,
  setSearchHotkey,
  screenshotHotkey,
  setScreenshotHotkey,
  sequentialMode,
  isRecording,
  setIsRecording,
  isRecordingSequential,
  setIsRecordingSequential,
  isRecordingRich,
  setIsRecordingRich,
  isRecordingSearch,
  setIsRecordingSearch,
  isRecordingScreenshot,
  setIsRecordingScreenshot,
  saveAppSetting,
  t,
  pushToast
}: UseHotkeyConfigOptions) => {
  const checkHotkeyConflict = useCallback(
    (newHotkey: string, mode: HotkeyMode): boolean => {
      if (!newHotkey) return false;

      const conflicts = [];
      if (mode !== "main" && newHotkey === hotkey) conflicts.push(t("global_hotkey"));
      if (mode !== "sequential" && sequentialMode && newHotkey === sequentialHotkey) {
        conflicts.push(t("sequential_paste_hotkey_label"));
      }
      if (mode !== "rich" && newHotkey === richPasteHotkey) {
        conflicts.push(t("rich_paste_hotkey_label"));
      }
      if (mode !== "search" && newHotkey === searchHotkey) {
        conflicts.push(t("search_hotkey_label"));
      }
      if (mode !== "screenshot" && newHotkey === screenshotHotkey) {
        conflicts.push(t("screenshot_hotkey_label"));
      }

      if (conflicts.length > 0) {
        const msg = t("hotkey_conflict_toast").replace("{name}", conflicts[0]);
        pushToast(msg, 5000);
        return true;
      }
      return false;
    },
    [hotkey, sequentialMode, sequentialHotkey, richPasteHotkey, searchHotkey, screenshotHotkey, t, pushToast]
  );

  const updateHotkey = useCallback(
    async (newHotkey: string) => {
      if (newHotkey === hotkey) {
        setIsRecording(false);
        return;
      }
      const hasConflict = checkHotkeyConflict(newHotkey, "main");
      if (hasConflict) {
        setIsRecording(false);
        return;
      }

      if (newHotkey) {
        try {
          await invoke<boolean>("test_hotkey_available", { hotkey: newHotkey });
        } catch (err) {
          const errorMsg = `❌ ${newHotkey}: ${err || "快捷键被占用"}`;
          pushToast(errorMsg, 5000);
          setIsRecording(false);
          return;
        }
      }

      setHotkey(newHotkey);
      saveAppSetting("hotkey", newHotkey);
      await invoke("register_hotkey", { hotkey: newHotkey }).catch((err) => {
        if (newHotkey) {
          const errorMsg = t("hotkey_register_failed") + (err?.toString() || "");
          pushToast(errorMsg, 3000);
        }
      });
      setIsRecording(false);
    },
    [checkHotkeyConflict, hotkey, pushToast, saveAppSetting, setHotkey, setIsRecording, t]
  );

  const updateSequentialHotkey = useCallback(
    async (newHotkey: string) => {
      const hasConflict = checkHotkeyConflict(newHotkey, "sequential");
      if (hasConflict) {
        setIsRecordingSequential(false);
        return;
      }

      if (newHotkey) {
        try {
          await invoke<boolean>("test_hotkey_available", { hotkey: newHotkey });
        } catch (err) {
          const errorMsg = `❌ ${newHotkey}: ${err || "快捷键被占用"}`;
          pushToast(errorMsg, 5000);
          setIsRecordingSequential(false);
          return;
        }
      }

      setSequentialHotkey(newHotkey);
      saveAppSetting("sequential_hotkey", newHotkey);
      await invoke("set_sequential_hotkey", { hotkey: newHotkey }).catch(console.error);
      setIsRecordingSequential(false);
    },
    [
      checkHotkeyConflict,
      pushToast,
      saveAppSetting,
      setSequentialHotkey,
      setIsRecordingSequential
    ]
  );

  const updateRichPasteHotkey = useCallback(
    async (newHotkey: string) => {
      const hasConflict = checkHotkeyConflict(newHotkey, "rich");
      if (hasConflict) {
        setIsRecordingRich(false);
        return;
      }

      if (newHotkey) {
        try {
          await invoke<boolean>("test_hotkey_available", { hotkey: newHotkey });
        } catch (err) {
          const errorMsg = `❌ ${newHotkey}: ${err || "快捷键被占用"}`;
          pushToast(errorMsg, 5000);
          setIsRecordingRich(false);
          return;
        }
      }

      setRichPasteHotkey(newHotkey);
      saveAppSetting("rich_paste_hotkey", newHotkey);
      await invoke("set_rich_paste_hotkey", { hotkey: newHotkey }).catch(console.error);
      setIsRecordingRich(false);
    },
    [
      checkHotkeyConflict,
      pushToast,
      saveAppSetting,
      setRichPasteHotkey,
      setIsRecordingRich
    ]
  );

  const updateSearchHotkey = useCallback(
    async (newHotkey: string) => {
      const hasConflict = checkHotkeyConflict(newHotkey, "search");
      if (hasConflict) {
        setIsRecordingSearch(false);
        return;
      }

      if (newHotkey) {
        try {
          await invoke<boolean>("test_hotkey_available", { hotkey: newHotkey });
        } catch (err) {
          const errorMsg = `❌ ${newHotkey}: ${err || "快捷键被占用"}`;
          pushToast(errorMsg, 5000);
          setIsRecordingSearch(false);
          return;
        }
      }

      setSearchHotkey(newHotkey);
      saveAppSetting("search_hotkey", newHotkey);
      await invoke("set_search_hotkey", { hotkey: newHotkey }).catch(console.error);
      setIsRecordingSearch(false);
    },
    [
      checkHotkeyConflict,
      pushToast,
      saveAppSetting,
      setSearchHotkey,
      setIsRecordingSearch
    ]
  );

  const updateScreenshotHotkey = useCallback(
    async (newHotkey: string) => {
      if (newHotkey === screenshotHotkey || checkHotkeyConflict(newHotkey, "screenshot")) {
        setIsRecordingScreenshot(false);
        return;
      }

      if (newHotkey) {
        try {
          await invoke<boolean>("test_hotkey_available", { hotkey: newHotkey });
        } catch (err) {
          pushToast(`${newHotkey}: ${err || "快捷键被占用"}`, 5000);
          setIsRecordingScreenshot(false);
          return;
        }
      }

      try {
        await invoke("set_screenshot_hotkey", { hotkey: newHotkey });
        setScreenshotHotkey(newHotkey);
        saveAppSetting("screenshot_hotkey", newHotkey);
      } catch (err) {
        pushToast(t("hotkey_register_failed") + String(err), 5000);
      }
      setIsRecordingScreenshot(false);
    },
    [checkHotkeyConflict, pushToast, saveAppSetting, screenshotHotkey, setIsRecordingScreenshot, setScreenshotHotkey, t]
  );

  useEffect(() => {
    invoke("set_recording_mode", {
      enabled: isRecording || isRecordingSequential || isRecordingRich
        || isRecordingSearch || isRecordingScreenshot
    }).catch(console.error);

    if (isRecording || isRecordingSequential || isRecordingRich || isRecordingSearch || isRecordingScreenshot) {
      const unlisten = listen<string>("hotkey-recorded", (event) => {
        if (isRecording) updateHotkey(event.payload);
        if (isRecordingSequential) updateSequentialHotkey(event.payload);
        if (isRecordingRich) updateRichPasteHotkey(event.payload);
        if (isRecordingSearch) updateSearchHotkey(event.payload);
        if (isRecordingScreenshot) updateScreenshotHotkey(event.payload);
      });

      const unlistenCancel = listen("recording-cancelled", () => {
        setIsRecording(false);
        setIsRecordingSequential(false);
        setIsRecordingRich(false);
        setIsRecordingSearch(false);
        setIsRecordingScreenshot(false);
      });

      return () => {
        unlisten.then((f) => f());
        unlistenCancel.then((f) => f());
      };
    }
  }, [
    isRecording,
    isRecordingSequential,
    isRecordingRich,
    isRecordingSearch,
    isRecordingScreenshot,
    setIsRecording,
    setIsRecordingSequential,
    setIsRecordingRich,
    setIsRecordingSearch,
    setIsRecordingScreenshot,
    updateHotkey,
    updateSequentialHotkey,
    updateRichPasteHotkey,
    updateSearchHotkey,
    updateScreenshotHotkey
  ]);

  return {
    checkHotkeyConflict,
    updateHotkey,
    updateSequentialHotkey,
    updateRichPasteHotkey,
    updateSearchHotkey,
    updateScreenshotHotkey
  };
};

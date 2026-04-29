import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface SpeakerChipProps {
  speaker: string;
  participants: string[];
  onChangeSpeaker: (name: string) => void;
  onAddParticipant: (name: string) => void;
  onOpenChange?: (isOpen: boolean) => void;
}

export function SpeakerChip({
  speaker,
  participants,
  onChangeSpeaker,
  onAddParticipant,
  onOpenChange,
}: SpeakerChipProps) {
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const chipRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isOpen = dropdownPos !== null;

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        chipRef.current &&
        !chipRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setDropdownPos(null);
        setIsAdding(false);
        setNewName("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleToggle = () => {
    if (isOpen) {
      setDropdownPos(null);
      setIsAdding(false);
      setNewName("");
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) {
      setDropdownPos({ top: rect.bottom + 4, left: rect.left });
    }
  };

  const handleSelect = (name: string) => {
    onChangeSpeaker(name);
    setDropdownPos(null);
    setIsAdding(false);
    setNewName("");
  };

  const handleAddNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onAddParticipant(trimmed);
    onChangeSpeaker(trimmed);
    setDropdownPos(null);
    setIsAdding(false);
    setNewName("");
  };

  return (
    <div className="inline-block" ref={chipRef}>
      <button
        className="badge badge-sm badge-outline cursor-pointer hover:badge-primary transition-colors"
        onClick={handleToggle}
        title="Change speaker"
      >
        {speaker}
      </button>
      {dropdownPos &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed z-[9999] bg-base-100 border border-base-300 rounded-lg shadow-xl min-w-[140px] py-1"
            style={{ top: dropdownPos.top, left: dropdownPos.left }}
          >
            {participants.map((name) => (
              <button
                key={name}
                className={`w-full text-left px-3 py-1 text-xs hover:bg-base-300 transition-colors ${name === speaker ? "font-semibold text-primary" : ""}`}
                onClick={() => handleSelect(name)}
              >
                {name}
              </button>
            ))}
            <div className="border-t border-base-300 mt-1 pt-1">
              {isAdding ? (
                <form
                  className="px-2 flex gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleAddNew();
                  }}
                >
                  <input
                    type="text"
                    className="input input-xs input-bordered flex-1 min-w-0"
                    placeholder="Name..."
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                  <button type="submit" className="btn btn-xs btn-primary">
                    +
                  </button>
                </form>
              ) : (
                <button
                  className="w-full text-left px-3 py-1 text-xs text-primary hover:bg-base-300 transition-colors"
                  onClick={() => setIsAdding(true)}
                >
                  + Add new…
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

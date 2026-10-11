// The rules between MIDI and voices, shared by the live voice host and the
// offline render of a recorded take (keyboard-instrument.md §2.6, §12), so
// a take renders with exactly the voicing it was played with: one voice
// per sounding note, the sustain pedal (CC 64), All Notes Off (CC 123),
// pitch bend of up to two semitones on every sounding voice, and the
// modulation wheel (CC 1) as `mod`, from 0 to 1, on every voice
// (keyboard-instrument.md §14).
//
// Its value is a function of three callbacks and an optional fourth:
//   start.(note, velocity, freq, mod) -> a voice
//   set.(voice, control, value), for \freq and \mod
//   release.(voice)
//   onVoice.(note, sounding), told as each voice starts and ends
// and returns an Event that takes noteOn, noteOff, cc, bend, and
// forgetVoices. No entry may share a name with a method Event already has,
// such as clear (Set.clear): the method runs instead, and empties the Event.
{ |start, set, release, onVoice|
	var voices = Dictionary.new, sustained = Set.new, sustainDown = false, bend = 0, mod = 0;
	var releaseKey, freqOf;
	freqOf = { |note| (note + bend).midicps };
	releaseKey = { |key|
		voices.removeAt(key) !? { |voice|
			release.(voice);
			onVoice !? { onVoice.(key % 128, false) };
		};
	};
	(
		noteOn: { |self, chan, note, velocity|
			var key = chan * 128 + note;
			if (velocity == 0) { self.noteOff(chan, note) } {
				voices[key] !? { |old| release.(old) };
				sustained.remove(key);
				voices[key] = start.(note, velocity, freqOf.(note), mod);
				onVoice !? { onVoice.(note, true) };
			};
		},
		noteOff: { |self, chan, note|
			var key = chan * 128 + note;
			if (sustainDown) { sustained.add(key) } { releaseKey.(key) };
		},
		cc: { |self, chan, number, value|
			case
			{ number == 1 } {
				mod = value / 127;
				voices.do { |voice| set.(voice, \mod, mod) };
			}
			{ number == 64 } {
				if (value >= 64) { sustainDown = true } {
					sustainDown = false;
					sustained.copy.do(releaseKey);
					sustained.clear;
				};
			}
			{ number == 123 } {
				voices.keys.copy.do(releaseKey);
				sustained.clear;
			};
		},
		bend: { |self, chan, value|
			bend = (value - 8192) / 8192 * 2;
			voices.keysValuesDo { |key, voice| set.(voice, \freq, freqOf.(key % 128)) };
		},
		forgetVoices: { |self|
			voices.clear;
			sustained.clear;
			sustainDown = false;
		}
	)
}

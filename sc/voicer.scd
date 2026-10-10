// The rules between MIDI and voices, shared by the live voice host and the
// offline render of a recorded take (keyboard-instrument.md §2.6, §12), so
// a take renders with exactly the voicing it was played with: one voice
// per sounding note, the sustain pedal (CC 64), All Notes Off (CC 123),
// and pitch bend of up to two semitones on every sounding voice.
//
// Its value is a function of three callbacks:
//   start.(note, velocity, freq) -> a voice
//   setFreq.(voice, freq)
//   release.(voice)
// and returns an Event that takes noteOn, noteOff, cc, bend, and clear.
{ |start, setFreq, release, onVoice|
	var voices = Dictionary.new, sustained = Set.new, sustainDown = false, bend = 0;
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
				voices[key] = start.(note, velocity, freqOf.(note));
				onVoice !? { onVoice.(note, true) };
			};
		},
		noteOff: { |self, chan, note|
			var key = chan * 128 + note;
			if (sustainDown) { sustained.add(key) } { releaseKey.(key) };
		},
		cc: { |self, chan, number, value|
			case
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
			voices.keysValuesDo { |key, voice| setFreq.(voice, freqOf.(key % 128)) };
		},
		clear: { |self|
			voices.clear;
			sustained.clear;
			sustainDown = false;
		}
	)
}

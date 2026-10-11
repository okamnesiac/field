// still water pad — the D-minor pad as a recipe instead of a rendered file.
// Twelve detuned sine voices (three per chord tone), panned and drifting
// slightly, under a slow sine envelope. Runs under Field's sc-render
// contract: parameters arrive in the environment, output goes to
// FIELD_OUTPUT, and the render is deterministic for a given FIELD_SEED.
//
// Under FIELD_MODE=voice it renders nothing: its value is one voice of the
// pad, gated, which `field keys still-water-pad` plays from the keyboard
// (keyboard-instrument.md §2.6).
(
if ("FIELD_MODE".getenv == "voice") {
	SynthDef(\stillWaterKey, { |out = 0, freq = 220, amp = 0.5, gate = 1|
		var env = EnvGen.kr(Env.asr(1.5, 1, 2.5, \sine), gate, doneAction: 2);
		var voices = [[-0.0012, -0.5], [0, 0], [0.0012, 0.5]].collect { |detunePan|
			var f = freq * (1 + detunePan[0]);
			Pan2.ar(SinOsc.ar(f) + (0.35 * SinOsc.ar(f * 2)), detunePan[1])
		};
		Out.ar(out, voices.sum * amp * 0.12 * env);
	})
} {
	var seed = "FIELD_SEED".getenv.asInteger;
	var dur = "FIELD_DURATION".getenv.asFloat;
	var rate = "FIELD_SAMPLE_RATE".getenv.asInteger;
	var out = "FIELD_OUTPUT".getenv;
	var chans = "FIELD_CHANNELS".getenv.asInteger;
	var events, score;
	thisThread.randSeed = seed;

	SynthDef(\stillWaterVoice, { |freq = 220, amp = 0.05, detune = 0, pan = 0, atk = 2.5, sus = 5, rel = 2.5|
		var env = EnvGen.kr(Env.linen(atk, sus, rel, curve: \sine), doneAction: 2);
		var f = freq * (1 + detune);
		var sig = SinOsc.ar(f) + (0.35 * SinOsc.ar(f * 2));
		Out.ar(0, Pan2.ar(sig * amp * env, pan));
	}).store;

	events = [];
	[146.83, 174.61, 220.0, 293.66].do { |freq| // D3 F3 A3 D4
		3.do {
			events = events.add([0.0,
				Synth.basicNew(\stillWaterVoice).newMsg(args: [
					\freq, freq,
					\amp, 0.045,
					\detune, rrand(-0.0015, 0.0015),
					\pan, rrand(-0.6, 0.6),
					\atk, dur * 0.25,
					\sus, dur * 0.5,
					\rel, dur * 0.25
				])
			]);
		};
	};
	score = Score(events ++ [[dur, [0]]]);
	score.recordNRT(
		outputFilePath: out,
		sampleRate: rate,
		headerFormat: "WAV",
		sampleFormat: "int24",
		options: ServerOptions.new.numOutputBusChannels_(chans),
		duration: dur,
		action: { 0.exit }
	);
}
)

using Concentus;
using Concentus.Enums;

namespace CarRadio.Companion;

/// <summary>Encodes 20 ms blocks of 48 kHz stereo PCM into raw Opus packets.</summary>
public sealed class OpusStream
{
    public const int FrameSize = AudioCapture.SampleRate / 50; // 960 samples per channel = 20 ms

    readonly IOpusEncoder _encoder;
    readonly byte[] _packet = new byte[4000];
    uint _seq;

    /// <summary>Called with (sequence, packet bytes, length).</summary>
    public event Action<uint, byte[], int>? Packet;

    public OpusStream(int bitrate = 128000)
    {
        _encoder = OpusCodecFactory.CreateEncoder(AudioCapture.SampleRate, AudioCapture.Channels, OpusApplication.OPUS_APPLICATION_AUDIO);
        _encoder.Bitrate = bitrate;
        _encoder.Complexity = 8;
        _encoder.SignalType = OpusSignal.OPUS_SIGNAL_MUSIC;
    }

    /// <summary>Encode one 20 ms block (FrameSize * 2 interleaved samples).</summary>
    public void Encode(short[] interleaved, int count)
    {
        if (count < FrameSize * AudioCapture.Channels) return;
        int len = _encoder.Encode(interleaved.AsSpan(0, FrameSize * AudioCapture.Channels), FrameSize, _packet, _packet.Length);
        if (len > 0) Packet?.Invoke(_seq++, _packet, len);
    }
}

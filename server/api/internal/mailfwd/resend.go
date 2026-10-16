package mailfwd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type received struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	ReplyTo []string `json:"reply_to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html"`
	Text    string   `json:"text"`
}

type attachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	DownloadURL string `json:"download_url"`
	Size        int64  `json:"size"`
}

type outAttachment struct {
	Filename    string `json:"filename"`
	Content     string `json:"content"`
	ContentType string `json:"content_type,omitempty"`
}

type outgoing struct {
	From        string          `json:"from"`
	To          []string        `json:"to"`
	ReplyTo     []string        `json:"reply_to,omitempty"`
	Subject     string          `json:"subject"`
	HTML        string          `json:"html,omitempty"`
	Text        string          `json:"text"`
	Attachments []outAttachment `json:"attachments,omitempty"`
}

type client struct {
	cfg Config
	req *http.Request
}

func (c client) forward(id string) error {
	var msg received
	if err := c.api(http.MethodGet, "/emails/receiving/"+url.PathEscape(id), nil, "", &msg); err != nil {
		return fmt.Errorf("fetching the message: %w", err)
	}
	atts, err := c.attachments(id)
	if err != nil {
		return err
	}
	return c.api(http.MethodPost, "/emails", compose(c.cfg, msg, atts), "kefli-mailfwd/"+id, nil)
}

func (c client) attachments(id string) ([]outAttachment, error) {
	var list struct {
		Data []attachment `json:"data"`
	}
	if err := c.api(http.MethodGet, "/emails/receiving/"+url.PathEscape(id)+"/attachments", nil, "", &list); err != nil {
		return nil, fmt.Errorf("listing attachments: %w", err)
	}
	var out []outAttachment
	var total int64
	for _, a := range list.Data {
		if total += a.Size; total > maxAttachments {
			return nil, fmt.Errorf("attachments over %d bytes", maxAttachments)
		}
		b, err := c.download(a.DownloadURL)
		if err != nil {
			return nil, fmt.Errorf("downloading an attachment: %w", err)
		}
		out = append(out, outAttachment{a.Filename, base64.StdEncoding.EncodeToString(b), a.ContentType})
	}
	return out, nil
}

// compose keeps the message as it came and puts a line above it saying who wrote it and to which address, since the
// forward itself is from the operator's domain.
func compose(cfg Config, msg received, atts []outAttachment) outgoing {
	replyTo := msg.ReplyTo
	if len(replyTo) == 0 && msg.From != "" {
		replyTo = []string{msg.From}
	}
	note := fmt.Sprintf("From %s to %s, forwarded by Kefli.", msg.From, strings.Join(msg.To, ", "))
	out := outgoing{
		From: cfg.From, To: []string{cfg.To}, ReplyTo: replyTo, Subject: msg.Subject,
		Text: note + "\n\n" + msg.Text, Attachments: atts,
	}
	if msg.HTML != "" {
		out.HTML = "<p style=\"color:#666;font-size:13px\">" + html.EscapeString(note) + "</p><hr>" + msg.HTML
	}
	return out
}

func (c client) api(method, path string, body any, idempotency string, into any) error {
	var rd io.Reader
	if body != nil {
		// as it came: json.Marshal writes each <, > and & of a message's HTML as six bytes
		var b bytes.Buffer
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(body); err != nil {
			return err
		}
		rd = &b
	}
	req, err := http.NewRequestWithContext(c.req.Context(), method, c.cfg.APIBase+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	if idempotency != "" {
		req.Header.Set("Idempotency-Key", idempotency)
	}
	resp, err := c.cfg.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("%s %s: %s", method, path, resp.Status)
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(into)
}

// download fetches a signed attachment URL, which carries its own authority, so no API key goes with it.
func (c client) download(u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(c.req.Context(), http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.cfg.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%s", resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxAttachments+1))
}
